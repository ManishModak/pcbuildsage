from __future__ import annotations

import asyncio
from dataclasses import replace
from typing import Any, Callable
from urllib.parse import quote, urljoin

from .extractor import extract_products, raw_from_llm_payload
from .llm_client import LLMClient
from .models import BrowserConfig, CategoryConfig, RawProduct, SiteConfig


class CrawlError(RuntimeError):
    """Raised when crawling or fallback extraction cannot continue."""


class Crawl4AIFetcher:
    def __init__(self) -> None:
        self._crawlers: dict[BrowserConfig, Any] = {}
        self._crawler_contexts: dict[BrowserConfig, Any] = {}
        self._crawler_run_config: Any | None = None
        self._cache_mode: Any | None = None
        self._start_lock = asyncio.Lock()

    async def __aenter__(self) -> "Crawl4AIFetcher":
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()

    async def close(self) -> None:
        for crawler_context in self._crawler_contexts.values():
            await crawler_context.__aexit__(None, None, None)
        self._crawlers.clear()
        self._crawler_contexts.clear()
        self._crawler_run_config = None
        self._cache_mode = None

    def _crawler_key(self, site: SiteConfig) -> BrowserConfig:
        return site.browser_config

    async def _ensure_crawler(self, site: SiteConfig) -> Any:
        key = self._crawler_key(site)
        if key in self._crawlers:
            return self._crawlers[key]
        async with self._start_lock:
            if key in self._crawlers:
                return self._crawlers[key]
            try:
                from crawl4ai import AsyncWebCrawler, BrowserConfig as C4ABrowserConfig, CacheMode, CrawlerRunConfig  # type: ignore
            except Exception as exc:
                raise CrawlError("crawl4ai is not importable; install src/scraper/requirements.txt") from exc

            browser_cfg = C4ABrowserConfig(
                headless=site.browser_config.headless,
                java_script_enabled=site.browser_config.js_rendering,
            )
            crawler_context = AsyncWebCrawler(config=browser_cfg)
            try:
                crawler = await crawler_context.__aenter__()
            except BaseException:
                try:
                    await crawler_context.__aexit__(None, None, None)
                except Exception:
                    pass
                raise
            self._crawler_contexts[key] = crawler_context
            self._crawlers[key] = crawler
            self._crawler_run_config = CrawlerRunConfig
            self._cache_mode = CacheMode
            return crawler

    async def fetch(self, url: str, site: SiteConfig) -> str:
        crawler = await self._ensure_crawler(site)
        run_cfg = self._crawler_run_config(
            cache_mode=self._cache_mode.BYPASS,
            wait_for=f"css:{site.browser_config.wait_for_selector}" if site.browser_config.wait_for_selector else None,
            page_timeout=site.browser_config.timeout_ms,
            scan_full_page=site.browser_config.scroll_down,
            scroll_delay=0.5 if site.browser_config.scroll_down else 0,
            delay_before_return_html=0.5,
        )
        result = await crawler.arun(url=url, config=run_cfg)
        success = bool(getattr(result, "success", False))
        if not success:
            raise CrawlError(str(getattr(result, "error_message", "crawl failed")))
        return getattr(result, "html", None) or getattr(result, "cleaned_html", "")


def category_page_url(site: SiteConfig, category: CategoryConfig, page: int) -> str:
    base = urljoin(site.base_url, category.path)
    if page <= 1:
        return base
    pattern = (category.pagination_pattern or "?page={page}").format(page=page)
    return urljoin(base.rstrip("/") + "/", pattern) if not pattern.startswith("?") else base + pattern


def search_page_url(site: SiteConfig, category: CategoryConfig, query: str) -> str:
    pattern = category.search_pattern or category.path
    if "{query}" not in pattern:
        pattern = f"{pattern}?q={{query}}"
    return urljoin(site.base_url, pattern.format(query=quote(query)))


class ScraperCrawler:
    def __init__(
        self,
        fetcher: Crawl4AIFetcher | None = None,
        delay_ms: int = 1000,
        selector_failure_threshold: int = 10,
        llm_client: LLMClient | None = None,
        llm_enabled: bool = True,
        max_llm_calls: int = 25,
    ) -> None:
        self.fetcher = fetcher or Crawl4AIFetcher()
        self.delay_ms = delay_ms
        self.selector_failure_threshold = selector_failure_threshold
        self.llm_client = llm_client
        self.llm_enabled = llm_enabled
        self.max_llm_calls = max_llm_calls
        self.llm_calls = 0

    def _should_invoke_llm(self, failed: list[RawProduct], cumulative_selector_failures: int) -> bool:
        return bool(
            failed
            and self.llm_enabled
            and self.llm_client
            and cumulative_selector_failures >= self.selector_failure_threshold
            and self.llm_calls < self.max_llm_calls
        )

    def _apply_extraction_fallback(
        self,
        site: SiteConfig,
        raw_products: list[RawProduct],
        cumulative_selector_failures: int,
    ) -> tuple[list[RawProduct], int]:
        failed = [product for product in raw_products if not product.title or not product.price_text or not product.url]
        cumulative_selector_failures = cumulative_selector_failures + len(failed) if failed else 0
        if not self._should_invoke_llm(failed, cumulative_selector_failures):
            return raw_products, cumulative_selector_failures

        self.llm_calls += 1
        fallback = raw_from_llm_payload(self.llm_client.extract_products([item.source_html for item in failed]), site.base_url)
        if fallback:
            return [product for product in raw_products if product not in failed] + fallback, 0
        raise CrawlError(f"{site.site_name}: selector and LLM extraction both failed")

    async def crawl_category(
        self,
        site: SiteConfig,
        category: CategoryConfig,
        page_limit: int,
        on_page: Callable[[int, list[RawProduct], str], None] | None = None,
    ) -> list[RawProduct]:
        products: list[RawProduct] = []
        cumulative_selector_failures = 0
        for page in range(1, page_limit + 1):
            url = category_page_url(site, category, page)
            html = await self.fetcher.fetch(url, site)
            raw_products = extract_products(html, site.selectors, site.base_url)
            if not raw_products:
                break
            raw_products, cumulative_selector_failures = self._apply_extraction_fallback(site, raw_products, cumulative_selector_failures)
            products.extend(raw_products)
            if on_page:
                on_page(page, raw_products, html)
            if self.delay_ms > 0 and page < page_limit:
                await asyncio.sleep(self.delay_ms / 1000)
        return products

    async def crawl_search(
        self,
        site: SiteConfig,
        category: CategoryConfig,
        terms: list[str],
        term_limit: int,
        on_page: Callable[[int, list[RawProduct], str], None] | None = None,
    ) -> list[RawProduct]:
        products: list[RawProduct] = []
        cumulative_selector_failures = 0
        one_page_site = replace(site, scraping_type="category")
        limited_terms = terms[:term_limit]
        for index, term in enumerate(limited_terms, start=1):
            html = await self.fetcher.fetch(search_page_url(site, category, term), one_page_site)
            raw_products = extract_products(html, site.selectors, site.base_url)
            raw_products, cumulative_selector_failures = self._apply_extraction_fallback(site, raw_products, cumulative_selector_failures)
            products.extend(raw_products)
            if on_page:
                on_page(index, raw_products, html)
            if self.delay_ms > 0 and index < len(limited_terms):
                await asyncio.sleep(self.delay_ms / 1000)
        return products
