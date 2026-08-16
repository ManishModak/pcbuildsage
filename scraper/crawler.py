from __future__ import annotations

import asyncio
import gzip
import logging
import urllib.error
import urllib.request
from dataclasses import dataclass, field, replace
from typing import Any, Callable
from urllib.parse import quote, urljoin

from .extractor import extract_products, raw_from_llm_payload
from .llm_client import LLMClient
from .models import BrowserConfig, CategoryConfig, RawProduct, SiteConfig

logger = logging.getLogger(__name__)

DEFAULT_HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Sec-Ch-Ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}

WAF_MARKERS = (
    "<title>just a moment...</title>",
    "<title>attention required! | cloudflare</title>",
    "<title>ddos-guard</title>",
    "challenge-platform",
    "cf-browser-verification",
    "ray id:",
)


class CrawlError(RuntimeError):
    """Raised when crawling or fallback extraction cannot continue."""


@dataclass
class ExtractionFallbackState:
    selector_failures: int = 0
    failed_products: list[RawProduct] = field(default_factory=list)


def validate_extracted_products(
    raw_products: list[RawProduct],
    html: str,
    site: SiteConfig,
    is_first_page: bool = True,
) -> tuple[bool, str]:
    """Validate HTML content and extracted product quality before accepting an engine result."""
    if not html or not html.strip():
        return False, "Empty HTML response"

    html_lower = html[:4000].lower()
    for marker in WAF_MARKERS:
        if marker in html_lower:
            return False, f"WAF/Anti-bot challenge detected ({marker})"

    if is_first_page:
        if not raw_products:
            return False, f"0 products extracted using container '{site.selectors.get('product_container')}'"

        complete = [p for p in raw_products if p.title and p.price_text and p.url]
        if not complete:
            return False, "Extracted products missing title, price, or url"

        complete_ratio = len(complete) / len(raw_products)
        if complete_ratio < 0.5:
            return False, f"Low field extraction coverage ({len(complete)}/{len(raw_products)} complete)"

        urls = [p.url for p in complete if p.url]
        if urls and (len(set(urls)) / len(urls)) < 0.5:
            return False, f"High URL duplication ({len(set(urls))} unique out of {len(urls)})"

    return True, "OK"


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

    async def fetch_http(self, url: str, site: SiteConfig, retries: int = 2) -> str:
        """Fetch a page via direct HTTP GET with full browser headers and 429 backoff."""
        def _sync_http_get() -> str:
            req = urllib.request.Request(url, headers=DEFAULT_HTTP_HEADERS)
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read()
                content_encoding = resp.info().get("Content-Encoding", "").lower()
                if "gzip" in content_encoding:
                    try:
                        data = gzip.decompress(data)
                    except Exception:
                        pass
                return data.decode("utf-8", errors="ignore")

        last_error = None
        for attempt in range(1, retries + 1):
            try:
                html = await asyncio.to_thread(_sync_http_get)
                if html:
                    return html
            except urllib.error.HTTPError as http_err:
                last_error = http_err
                if http_err.code == 429:
                    logger.warning(
                        "HTTP 429 Rate Limit for %s (attempt %d/%d). Backing off...",
                        url,
                        attempt,
                        retries,
                        extra={"component": "scraper"},
                    )
                    if attempt < retries:
                        await asyncio.sleep(2.0 * attempt)
                        continue
                logger.warning(
                    "HTTP request failed for %s (attempt %d/%d): status %d",
                    url,
                    attempt,
                    retries,
                    http_err.code,
                    extra={"component": "scraper"},
                )
                if attempt < retries:
                    await asyncio.sleep(1.0 * attempt)
            except Exception as exc:
                last_error = exc
                logger.warning(
                    "HTTP fetch exception for %s (attempt %d/%d): %s",
                    url,
                    attempt,
                    retries,
                    str(exc),
                    extra={"component": "scraper"},
                )
                if attempt < retries:
                    await asyncio.sleep(1.0 * attempt)

        raise CrawlError(f"HTTP fetch failed for {url} after {retries} attempts: {last_error}")

    async def fetch_browser(self, url: str, site: SiteConfig, retries: int = 2) -> str:
        """Fetch a page using Crawl4AI headless browser."""
        last_error = None
        for attempt in range(1, retries + 1):
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
                status_code = getattr(result, "status_code", 200) or 200
                if success and status_code < 400:
                    html = getattr(result, "html", None) or getattr(result, "cleaned_html", "")
                    if html:
                        return html
                err_msg = str(getattr(result, "error_message", f"status {status_code}"))
                last_error = CrawlError(err_msg)
                logger.warning(
                    "Crawl4AI browser fetch failed for %s (attempt %d/%d): %s",
                    url,
                    attempt,
                    retries,
                    err_msg,
                    extra={"component": "scraper"},
                )
            except Exception as exc:
                last_error = exc
                logger.warning(
                    "Crawl4AI browser exception for %s (attempt %d/%d): %s",
                    url,
                    attempt,
                    retries,
                    str(exc),
                    extra={"component": "scraper"},
                )
            if attempt < retries:
                await asyncio.sleep(1.0 * attempt)

        raise CrawlError(f"Browser fetch failed for {url} after {retries} attempts: {last_error}")

    async def fetch(self, url: str, site: SiteConfig, retries: int = 2) -> str:
        """Default fetch dispatcher honoring site.engine ('http' or 'browser')."""
        engine = getattr(site, "engine", "browser") or "browser"
        if engine == "http":
            try:
                return await self.fetch_http(url, site, retries=retries)
            except Exception:
                return await self.fetch_browser(url, site, retries=retries)
        else:
            try:
                return await self.fetch_browser(url, site, retries=retries)
            except Exception:
                return await self.fetch_http(url, site, retries=retries)


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
    ) -> None:
        self.fetcher = fetcher or Crawl4AIFetcher()
        self.delay_ms = delay_ms
        self.selector_failure_threshold = selector_failure_threshold
        self.llm_client = llm_client
        self.llm_enabled = llm_enabled
        self.max_llm_calls = max_llm_calls
        self.llm_calls = 0
        self.active_engines: dict[str, str] = {}

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
        query_details = {
            "site": site.site_name,
            "failed_count": len(fallback_state.failed_products),
            "failed_products_html": [item.source_html[:500] for item in fallback_state.failed_products],
        }
        logger.info(
            "Invoking LLM extraction fallback for %s",
            site.site_name,
            extra={"component": "llm", "details": query_details},
        )

        payload = await asyncio.to_thread(self.llm_client.extract_products, [item.source_html for item in fallback_state.failed_products])

        response_details = {
            "site": site.site_name,
            "payload": payload,
        }
        logger.info(
            "LLM extraction fallback response received for %s",
            site.site_name,
            extra={"component": "llm", "details": response_details},
        )

        fallback = raw_from_llm_payload(payload, site.base_url)
        if fallback:
            fallback_state.selector_failures = 0
            fallback_state.failed_products.clear()
            return valid_products + fallback, fallback_state
        raise CrawlError(f"{site.site_name}: selector and LLM extraction both failed")

    async def _fetch_and_extract(
        self,
        url: str,
        site: SiteConfig,
        page: int,
    ) -> tuple[str, list[RawProduct]]:
        """Extraction-aware dual-engine fetcher with sticky failover."""
        has_dual = hasattr(self.fetcher, "fetch_http") and hasattr(self.fetcher, "fetch_browser")
        if not has_dual:
            html = await self.fetcher.fetch(url, site)
            raw_products = extract_products(html, site.selectors, site.base_url)
            return html, raw_products

        primary = self.active_engines.get(site.site_name, getattr(site, "engine", "browser") or "browser")
        secondary = "browser" if primary == "http" else "http"

        async def _try_engine(engine_name: str) -> tuple[str, list[RawProduct], bool, str]:
            try:
                if engine_name == "http":
                    fetched_html = await self.fetcher.fetch_http(url, site)
                else:
                    fetched_html = await self.fetcher.fetch_browser(url, site)
                extracted = extract_products(fetched_html, site.selectors, site.base_url)
                is_valid, reason = validate_extracted_products(extracted, fetched_html, site, is_first_page=(page == 1))
                return fetched_html, extracted, is_valid, reason
            except Exception as exc:
                return "", [], False, str(exc)

        # 1. Try primary engine
        html, raw_products, is_valid, reason = await _try_engine(primary)
        if is_valid or (page > 1 and not raw_products and "WAF" not in reason):
            return html, raw_products

        logger.warning(
            "%s: %s engine validation failed on %s (reason: %s). Attempting %s fallback.",
            site.site_name,
            primary,
            url,
            reason,
            secondary,
            extra={"component": "scraper"},
        )

        # 2. Try secondary fallback engine
        fb_html, fb_products, fb_valid, fb_reason = await _try_engine(secondary)
        if fb_valid or (page > 1 and not fb_products and "WAF" not in fb_reason):
            self.active_engines[site.site_name] = secondary
            logger.info(
                "%s: sticky failover activated, switched to %s engine.",
                site.site_name,
                secondary,
                extra={"component": "scraper"},
            )
            return fb_html, fb_products

        logger.error(
            "%s: both %s (%s) and %s (%s) engines failed validation on %s.",
            site.site_name,
            primary,
            reason,
            secondary,
            fb_reason,
            url,
            extra={"component": "scraper"},
        )
        if page == 1:
            raise CrawlError(f"{site.site_name}: both {primary} and {secondary} engines failed validation for {url}")
        return "", []

    async def crawl_category(
        self,
        site: SiteConfig,
        category: CategoryConfig,
        page_limit: int,
        on_page: Callable[[int, list[RawProduct], str], None] | None = None,
    ) -> list[RawProduct]:
        products: list[RawProduct] = []
        fallback_state = ExtractionFallbackState()
        seen_urls: set[str] = set()
        page = 1
        while page <= page_limit:
            url = category_page_url(site, category, page)
            try:
                html, raw_products = await self._fetch_and_extract(url, site, page)
            except CrawlError:
                if page > 1:
                    break
                raise

            if not raw_products:
                break

            # Pagination duplicate-signature guard (avoid infinite loops on repeating catalogs)
            page_urls = {p.url for p in raw_products if p.url}
            if page > 1 and page_urls and page_urls.issubset(seen_urls):
                logger.info(
                    "Pagination duplicate signature detected for %s/%s on page %d (all %d URLs already seen). Stopping pagination.",
                    site.site_name,
                    category.name,
                    page,
                    len(page_urls),
                    extra={"component": "scraper"},
                )
                break
            seen_urls.update(page_urls)

            # Detect actual page count from page 1 dynamically
            if page == 1 and category.pagination_pattern:
                detected_pages = detect_max_pages(html, category.pagination_pattern)
                if detected_pages:
                    page_limit = min(page_limit, detected_pages)

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
            url = search_page_url(site, category, term)
            try:
                html, raw_products = await self._fetch_and_extract(url, one_page_site, 1)
            except CrawlError:
                if index > 1:
                    continue
                raise
            if raw_products:
                raw_products, fallback_state = await self._apply_extraction_fallback(site, raw_products, fallback_state)
                products.extend(raw_products)
            if on_page:
                on_page(index, raw_products, html)
            if self.delay_ms > 0 and index < len(limited_terms):
                await asyncio.sleep(self.delay_ms / 1000)
        return products
