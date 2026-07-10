from __future__ import annotations

import asyncio
from dataclasses import dataclass, field, replace
from typing import Any, Callable
from urllib.parse import quote, urljoin

from .extractor import extract_products, raw_from_llm_payload
from .llm_client import LLMClient
from .models import BrowserConfig, CategoryConfig, RawProduct, SiteConfig


class CrawlError(RuntimeError):
    """Raised when crawling or fallback extraction cannot continue."""


@dataclass
class ExtractionFallbackState:
    selector_failures: int = 0
    failed_products: list[RawProduct] = field(default_factory=list)


class Crawl4AIFetcher:
    def __init__(self, db_path: str | None = None) -> None:
        self._crawlers: dict[BrowserConfig, Any] = {}
        self._crawler_contexts: dict[BrowserConfig, Any] = {}
        self._crawler_run_config: Any | None = None
        self._cache_mode: Any | None = None
        self._start_lock = asyncio.Lock()
        self.db_path = db_path

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
        from .db import write_db_log
        try:
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
            if success:
                html = getattr(result, "html", None) or getattr(result, "cleaned_html", "")
                if html:
                    return html
            else:
                err_msg = str(getattr(result, "error_message", "unknown error"))
                if self.db_path:
                    write_db_log(self.db_path, "WARN", "scraper", f"Crawl4AI fetch failed for {url}. Error: {err_msg}")
        except Exception as e:
            if self.db_path:
                write_db_log(self.db_path, "WARN", "scraper", f"Crawl4AI raised exception for {url}: {str(e)}")

        # Fallback to standard HTTP fetch for robust bot-bypass
        if self.db_path:
            write_db_log(self.db_path, "INFO", "scraper", f"Triggering self-healing HTTP fallback for {url}")
        try:
            import urllib.request
            req = urllib.request.Request(
                url,
                headers={
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            )
            def _http_get():
                with urllib.request.urlopen(req, timeout=15) as resp:
                    return resp.read().decode('utf-8', errors='ignore')
            html = await asyncio.to_thread(_http_get)
            if html:
                if self.db_path:
                    write_db_log(self.db_path, "INFO", "scraper", f"HTTP fallback succeeded for {url}")
                return html
        except Exception as http_exc:
            if self.db_path:
                write_db_log(self.db_path, "ERROR", "scraper", f"Crawl4AI and HTTP fallback both failed for {url}. Error: {http_exc}")
            raise CrawlError(f"Crawl4AI and HTTP fallback both failed. HTTP error: {http_exc}") from http_exc

        raise CrawlError("Crawl failed")


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


def detect_max_pages(html: str, pagination_pattern: str) -> int | None:
    if not pagination_pattern:
        return None
    import re
    from bs4 import BeautifulSoup
    
    escaped_pattern = re.escape(pagination_pattern)
    pattern_regex = escaped_pattern.replace(r"\{page\}", r"(\d+)")
    soup = BeautifulSoup(html, "html.parser")
    page_numbers = []
    
    for a in soup.find_all("a", href=True):
        href = a["href"]
        match = re.search(pattern_regex, href)
        if match:
            try:
                page_numbers.append(int(match.group(1)))
            except ValueError:
                pass
                
    if page_numbers:
        return max(page_numbers)
    return None


class ScraperCrawler:
    def __init__(
        self,
        fetcher: Crawl4AIFetcher | None = None,
        delay_ms: int = 1000,
        selector_failure_threshold: int = 10,
        llm_client: LLMClient | None = None,
        llm_enabled: bool = True,
        max_llm_calls: int = 25,
        db_path: str | None = None,
    ) -> None:
        self.fetcher = fetcher or Crawl4AIFetcher(db_path=db_path)
        self.delay_ms = delay_ms
        self.selector_failure_threshold = selector_failure_threshold
        self.llm_client = llm_client
        self.llm_enabled = llm_enabled
        self.max_llm_calls = max_llm_calls
        self.llm_calls = 0
        self.db_path = db_path

    def _should_invoke_llm(self, failed: list[RawProduct], cumulative_selector_failures: int) -> bool:
        return bool(
            failed
            and self.llm_enabled
            and self.llm_client
            and cumulative_selector_failures >= self.selector_failure_threshold
            and self.llm_calls < self.max_llm_calls
        )

    async def _apply_extraction_fallback(
        self,
        site: SiteConfig,
        raw_products: list[RawProduct],
        fallback_state: ExtractionFallbackState,
    ) -> tuple[list[RawProduct], ExtractionFallbackState]:
        failed = [product for product in raw_products if not product.title or not product.price_text or not product.url]
        valid_products = [product for product in raw_products if product not in failed]
        if failed:
            fallback_state.selector_failures += len(failed)
            fallback_state.failed_products.extend(failed)
        if not self._should_invoke_llm(fallback_state.failed_products, fallback_state.selector_failures):
            return valid_products, fallback_state

        self.llm_calls += 1
        from .db import write_db_log
        if self.db_path:
            query_details = {
                "site": site.site_name,
                "failed_count": len(fallback_state.failed_products),
                "failed_products_html": [item.source_html[:500] for item in fallback_state.failed_products]
            }
            write_db_log(self.db_path, "INFO", "llm", f"Invoking LLM extraction fallback for {site.site_name}", query_details)

        payload = await asyncio.to_thread(self.llm_client.extract_products, [item.source_html for item in fallback_state.failed_products])
        
        if self.db_path:
            response_details = {
                "site": site.site_name,
                "payload": payload
            }
            write_db_log(self.db_path, "INFO", "llm", f"LLM extraction fallback response received for {site.site_name}", response_details)

        fallback = raw_from_llm_payload(payload, site.base_url)
        if fallback:
            fallback_state.selector_failures = 0
            fallback_state.failed_products.clear()
            return valid_products + fallback, fallback_state
        raise CrawlError(f"{site.site_name}: selector and LLM extraction both failed")

    async def crawl_category(
        self,
        site: SiteConfig,
        category: CategoryConfig,
        page_limit: int,
        on_page: Callable[[int, list[RawProduct], str], None] | None = None,
    ) -> list[RawProduct]:
        products: list[RawProduct] = []
        fallback_state = ExtractionFallbackState()
        page = 1
        while page <= page_limit:
            url = category_page_url(site, category, page)
            try:
                html = await self.fetcher.fetch(url, site)
            except CrawlError:
                if page > 1:
                    break
                raise
            
            # Detect actual page count from page 1 dynamically
            if page == 1 and category.pagination_pattern:
                detected_pages = detect_max_pages(html, category.pagination_pattern)
                if detected_pages:
                    page_limit = min(page_limit, detected_pages)

            raw_products = extract_products(html, site.selectors, site.base_url)
            if not raw_products:
                break
            raw_products, fallback_state = await self._apply_extraction_fallback(site, raw_products, fallback_state)
            products.extend(raw_products)
            if on_page:
                on_page(page, raw_products, html)
            if self.delay_ms > 0 and page < page_limit:
                await asyncio.sleep(self.delay_ms / 1000)
            page += 1
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
        fallback_state = ExtractionFallbackState()
        one_page_site = replace(site, scraping_type="category")
        limited_terms = terms[:term_limit]
        for index, term in enumerate(limited_terms, start=1):
            html = await self.fetcher.fetch(search_page_url(site, category, term), one_page_site)
            raw_products = extract_products(html, site.selectors, site.base_url)
            raw_products, fallback_state = await self._apply_extraction_fallback(site, raw_products, fallback_state)
            products.extend(raw_products)
            if on_page:
                on_page(index, raw_products, html)
            if self.delay_ms > 0 and index < len(limited_terms):
                await asyncio.sleep(self.delay_ms / 1000)
        return products
