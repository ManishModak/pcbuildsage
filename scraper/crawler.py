from __future__ import annotations

import asyncio
import gzip
import logging
import math
import urllib.error
import urllib.request
import zlib
from dataclasses import dataclass, field, replace
from typing import Any, Callable
from urllib.parse import quote, urljoin, urlparse

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


# Statuses that mean "this listing page does not exist". On page 2+ they are
# the normal end of a listing (WooCommerce 404s /page/2/ on a one-page
# category), not a fetch failure.
NOT_FOUND_STATUSES = frozenset({404, 410})


class HttpStatusError(CrawlError):
    """A fetch that got a definitive HTTP status (surfaced for page-end checks)."""

    def __init__(self, url: str, status: int) -> None:
        super().__init__(f"HTTP {status} for {url}")
        self.url = url
        self.status = status

    @property
    def not_found(self) -> bool:
        return self.status in NOT_FOUND_STATUSES


class RedirectedToHomeError(CrawlError):
    """A listing URL redirected to the site homepage (the category moved).

    Definitive like a 404: the other engine follows the same redirect, and the
    homepage's promo carousels would otherwise be saved as this category.
    """

    def __init__(self, url: str, final_url: str) -> None:
        super().__init__(f"{url} redirected to homepage {final_url}; category path is stale")
        self.url = url
        self.final_url = final_url


def _check_not_redirected_home(url: str, final_url: str | None) -> None:
    """Raise when a non-root URL landed on the site root (query ignored)."""
    if not final_url:
        return
    if urlparse(url).path.strip("/") and not urlparse(final_url).path.strip("/"):
        raise RedirectedToHomeError(url, final_url)


def _validate_http_url(url: str) -> None:
    """Allow only http/https fetch targets (mirrors Node url-guard)."""
    try:
        scheme = urlparse(url).scheme.lower()
    except Exception as exc:
        raise CrawlError(f"Invalid URL {url!r}: {exc}") from exc
    if scheme not in ("http", "https"):
        raise CrawlError(f"Refusing to fetch non-http(s) URL: {url!r}")


def _decompress_deflate(data: bytes) -> bytes:
    """Decode deflate bodies (zlib wrapper or raw deflate stream)."""
    for window in (15, -15):
        try:
            return zlib.decompress(data, window)
        except Exception:
            continue
    return data


def _charset_from_meta(data: bytes) -> str | None:
    """Sniff <meta charset=...> from the first bytes without full parsing."""
    import re

    head = data[:4096].decode("ascii", errors="ignore").lower()
    match = re.search(r'<meta[^>]+charset\s*=\s*["\']?\s*([a-z0-9_\-]+)', head)
    if match:
        return match.group(1).strip()
    match = re.search(
        r'<meta[^>]+content\s*=\s*["\'][^"\']*charset\s*=\s*([a-z0-9_\-]+)', head
    )
    if match:
        return match.group(1).strip()
    return None


class CrawlProducts(list["RawProduct"]):
    """List of products that also records whether the crawl stopped early.

    Subclassing list keeps existing callers (`len()`, iteration,
    indexing) working while letting run_job distinguish a clean
    end-of-listing from a page-2+ fetch failure (partial crawl).
    """

    def __init__(
        self,
        iterable: list["RawProduct"] | tuple["RawProduct", ...] = (),
        partial: bool = False,
        partial_error: str | None = None,
    ) -> None:
        super().__init__(iterable)
        self.partial = partial
        self.partial_error = partial_error


# LLM fallback budget for a single Gemini call: must fit comfortably
# inside overall job timeouts and never hang a crawl page.
LLM_FALLBACK_TIMEOUT_S = 20.0


def _is_selector_failure_reason(reason: str) -> bool:
    """True when validation failed because selectors missed, not WAF/empty."""
    lowered = reason.lower()
    if "waf" in lowered or "anti-bot" in lowered or "empty html" in lowered:
        return False
    return (
        "0 products" in reason
        or "missing title" in lowered
        or "low field" in lowered
        or "low field extraction coverage" in lowered
        or "high url duplication" in lowered
    )


def validate_llm_items(items: list[dict[str, Any]], base_url: str) -> list[dict[str, Any]]:
    """Drop LLM items with wrong types or off-retailer URLs.

    The model must return plain JSON: title/price as strings (or price as a
    positive number, never a bool), in_stock as a real boolean, and an
    http(s) url on the retailer's domain.
    Anything else is discarded so a hallucinating model cannot poison the
    catalog or leak cross-site URLs.
    """
    try:
        base_host = (urlparse(base_url).hostname or "").casefold()
    except Exception:
        return []
    valid: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        title = item.get("title") or item.get("name")
        url = item.get("url")
        if not isinstance(title, str) or not title.strip():
            continue
        if not isinstance(url, str) or not url.strip():
            continue
        try:
            resolved = urljoin(base_url, url.strip())
            parsed = urlparse(resolved)
            scheme = parsed.scheme.lower()
            host = (parsed.hostname or "").casefold()
        except Exception:
            continue
        if scheme not in ("http", "https"):
            continue
        if not host or (base_host and host != base_host):
            continue
        in_stock = item.get("in_stock", True)
        if not isinstance(in_stock, bool):
            continue
        price_text = item.get("price_text", item.get("price"))
        if price_text is None or (isinstance(price_text, str) and not price_text.strip()):
            continue
        # bool is an int subclass: True must not pass as a price of 1.
        if isinstance(price_text, bool) or not isinstance(price_text, (str, int, float)):
            continue
        if isinstance(price_text, str):
            from .normalizer import parse_price as _parse_price

            price_value = _parse_price(price_text)
        else:
            price_value = float(price_text)
        if price_value is None or not math.isfinite(price_value) or price_value <= 0:
            continue
        valid.append(item)
    return valid


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
        # Close every browser even when one fails: a single __aexit__
        # raising must not strand the remaining Chromium processes.
        errors: list[BaseException] = []
        for crawler_context in list(self._crawler_contexts.values()):
            try:
                await crawler_context.__aexit__(None, None, None)
            except BaseException as exc:  # noqa: BLE001 - cleanup must continue
                errors.append(exc)
        self._crawlers.clear()
        self._crawler_contexts.clear()
        self._crawler_run_config = None
        self._cache_mode = None
        if errors:
            logger.warning(
                "Error closing %d browser context(s): %s",
                len(errors),
                errors[0],
                extra={"component": "scraper"},
            )

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
        _validate_http_url(url)

        def _sync_http_get() -> str:
            req = urllib.request.Request(url, headers=DEFAULT_HTTP_HEADERS)
            with urllib.request.urlopen(req, timeout=15) as resp:
                # urlopen follows redirects silently; geturl() is where we landed.
                _check_not_redirected_home(url, resp.geturl())
                data = resp.read()
                content_encoding = (resp.info().get("Content-Encoding", "") or "").lower()
                if "gzip" in content_encoding:
                    try:
                        data = gzip.decompress(data)
                    except Exception:
                        pass
                elif "deflate" in content_encoding:
                    data = _decompress_deflate(data)
                charset = resp.info().get_content_charset() or _charset_from_meta(data) or "utf-8"
                try:
                    return data.decode(charset, errors="ignore")
                except (LookupError, ValueError):
                    return data.decode("utf-8", errors="ignore")

        last_error = None
        for attempt in range(1, retries + 1):
            try:
                html = await asyncio.to_thread(_sync_http_get)
                if html:
                    return html
            except RedirectedToHomeError:
                raise
            except urllib.error.HTTPError as http_err:
                last_error = http_err
                if http_err.code in NOT_FOUND_STATUSES:
                    # Definitive answer: retrying cannot make the page exist.
                    raise HttpStatusError(url, http_err.code) from http_err
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
        _validate_http_url(url)
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
                if status_code in NOT_FOUND_STATUSES:
                    raise HttpStatusError(url, status_code)
                _check_not_redirected_home(url, getattr(result, "redirected_url", None))
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
            except (HttpStatusError, RedirectedToHomeError):
                raise
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
            except (HttpStatusError, RedirectedToHomeError):
                raise
            except Exception:
                return await self.fetch_browser(url, site, retries=retries)
        else:
            try:
                return await self.fetch_browser(url, site, retries=retries)
            except (HttpStatusError, RedirectedToHomeError):
                raise
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

    def _can_invoke_llm_now(self) -> bool:
        return bool(
            self.llm_enabled and self.llm_client and self.llm_calls < self.max_llm_calls
        )

    async def _run_llm_fallback(
        self, site: SiteConfig, blocks: list[str]
    ) -> list[RawProduct]:
        """Call Gemini with a timeout and validate types + retailer domain."""
        if not blocks or not self._can_invoke_llm_now():
            return []
        self.llm_calls += 1
        query_details = {
            "site": site.site_name,
            "failed_count": len(blocks),
            "failed_products_html": [b[:500] for b in blocks],
        }
        logger.info(
            "Invoking LLM extraction fallback for %s",
            site.site_name,
            extra={"component": "llm", "details": query_details},
        )
        try:
            payload = await asyncio.wait_for(
                asyncio.to_thread(self.llm_client.extract_products, blocks),
                timeout=LLM_FALLBACK_TIMEOUT_S,
            )
        except (asyncio.TimeoutError, TimeoutError) as exc:
            logger.warning(
                "LLM extraction fallback timed out for %s after %.0fs: %s",
                site.site_name,
                LLM_FALLBACK_TIMEOUT_S,
                exc,
                extra={"component": "llm"},
            )
            return []
        except Exception as exc:
            logger.warning(
                "LLM extraction fallback failed for %s: %s",
                site.site_name,
                exc,
                extra={"component": "llm"},
            )
            return []

        response_details = {
            "site": site.site_name,
            "payload": payload,
        }
        logger.info(
            "LLM extraction fallback response received for %s",
            site.site_name,
            extra={"component": "llm", "details": response_details},
        )
        if not isinstance(payload, list):
            return []
        validated = validate_llm_items(payload, site.base_url)
        if len(validated) < len(payload):
            logger.warning(
                "LLM fallback dropped %d/%d invalid items for %s (type or domain check)",
                len(payload) - len(validated),
                len(payload),
                site.site_name,
                extra={"component": "llm"},
            )
        return raw_from_llm_payload(validated, site.base_url)

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

        fallback = await self._run_llm_fallback(
            site, [item.source_html for item in fallback_state.failed_products if item.source_html]
        )
        if fallback:
            fallback_state.selector_failures = 0
            fallback_state.failed_products.clear()
            return valid_products + fallback, fallback_state
        # Failed fallback must not discard the good products on this page:
        # the caller decides partial vs failed based on previous pages.
        if valid_products:
            return valid_products, fallback_state
        raise CrawlError(f"{site.site_name}: selector and LLM extraction both failed")

    async def _fetch_and_extract(
        self,
        url: str,
        site: SiteConfig,
        page: int,
        retries: int = 2,
    ) -> tuple[str, list[RawProduct]]:
        """Extraction-aware dual-engine fetcher with sticky failover.

        A page-2+ HTTP 404/410 is the end of the listing and returns no
        products. Any other page-2+ fetch/validation failure (timeout, 5xx,
        WAF) raises CrawlError: callers mark the job partial and skip the
        stale sweep so good pages already scraped are kept.

        A redirect to the homepage raises RedirectedToHomeError on any page
        without trying the other engine or the LLM: page 1 fails the job.
        """
        _validate_http_url(url)
        has_dual = hasattr(self.fetcher, "fetch_http") and hasattr(self.fetcher, "fetch_browser")
        if not has_dual:
            try:
                html = await self.fetcher.fetch(url, site)
            except HttpStatusError as exc:
                if page > 1 and exc.not_found:
                    return "", []
                raise
            raw_products = extract_products(html, site.selectors, site.base_url)
            return html, raw_products

        primary = self.active_engines.get(site.site_name, getattr(site, "engine", "browser") or "browser")
        secondary = "browser" if primary == "http" else "http"

        end_of_listing = False

        async def _try_engine(engine_name: str) -> tuple[str, list[RawProduct], bool, str]:
            nonlocal end_of_listing
            try:
                if engine_name == "http":
                    try:
                        fetched_html = await self.fetcher.fetch_http(url, site, retries=retries)
                    except TypeError:
                        fetched_html = await self.fetcher.fetch_http(url, site)
                else:
                    try:
                        fetched_html = await self.fetcher.fetch_browser(url, site, retries=retries)
                    except TypeError:
                        fetched_html = await self.fetcher.fetch_browser(url, site)
                extracted = extract_products(fetched_html, site.selectors, site.base_url)
                is_valid, reason = validate_extracted_products(extracted, fetched_html, site, is_first_page=(page == 1))
                return fetched_html, extracted, is_valid, reason
            except RedirectedToHomeError:
                raise
            except HttpStatusError as exc:
                if page > 1 and exc.not_found:
                    end_of_listing = True
                return "", [], False, str(exc)
            except Exception as exc:
                return "", [], False, str(exc)

        # 1. Try primary engine
        html, raw_products, is_valid, reason = await _try_engine(primary)
        if is_valid:
            return html, raw_products
        if end_of_listing:
            # The server says the page does not exist: the listing ended.
            return "", []
        if page == 1 and _is_selector_failure_reason(reason):
            recovered = await self._maybe_llm_recover_page1(site, html, raw_products, url)
            if recovered is not raw_products:
                return html, recovered

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
        if end_of_listing:
            return "", []
        if fb_valid:
            self.active_engines[site.site_name] = secondary
            logger.info(
                "%s: sticky failover activated, switched to %s engine.",
                site.site_name,
                secondary,
                extra={"component": "scraper"},
            )
            return fb_html, fb_products
        if page == 1 and _is_selector_failure_reason(fb_reason):
            recovered = await self._maybe_llm_recover_page1(site, fb_html, fb_products, url)
            if recovered is not fb_products:
                self.active_engines[site.site_name] = secondary
                return fb_html, recovered

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
        # Page 2+ failure is never end-of-listing: raise so the caller can
        # mark the job partial and skip the stale sweep.
        raise CrawlError(f"{site.site_name}: both {primary} and {secondary} engines failed validation for {url}")

    async def _maybe_llm_recover_page1(
        self,
        site: SiteConfig,
        html: str,
        raw_products: list[RawProduct],
        url: str,
    ) -> list[RawProduct]:
        """Run LLM fallback on page 1 selector failures before rejecting.

        The "under 50% complete" rejection must not fire until the model has
        had a chance to recover the failed containers. Returns the original
        list when no recovery applies so callers can detect no-op via identity.
        """
        if not raw_products:
            if not html or not html.strip() or not self._can_invoke_llm_now():
                return raw_products
            blocks = [html[:12000]]
            complete: list[RawProduct] = []
        else:
            failed = [p for p in raw_products if not p.title or not p.price_text or not p.url]
            if not failed:
                return raw_products
            complete = [p for p in raw_products if p not in failed]
            if complete and len(complete) / len(raw_products) >= 0.5:
                return raw_products
            if not self._can_invoke_llm_now():
                return raw_products
            blocks = [p.source_html for p in failed if p.source_html] or [html[:12000]]
        fallback = await self._run_llm_fallback(site, blocks)
        if not fallback:
            return raw_products
        if not raw_products:
            return fallback
        return complete + fallback

    async def crawl_category(
        self,
        site: SiteConfig,
        category: CategoryConfig,
        page_limit: int,
        on_page: Callable[[int, list[RawProduct], str], None] | None = None,
    ) -> CrawlProducts:
        products = CrawlProducts()
        fallback_state = ExtractionFallbackState()
        seen_urls: set[str] = set()
        # True once page 1's pagination links told us the real page count;
        # reaching an undetected page_limit means pages may remain unseen.
        limit_confirmed = False
        page = 1
        while page <= page_limit:
            url = category_page_url(site, category, page)
            try:
                html, raw_products = await self._fetch_and_extract(url, site, page)
            except CrawlError as exc:
                # Page 2+ failure is a partial crawl, not end-of-listing.
                # Keep good pages and let run_job skip the stale sweep.
                if page > 1:
                    products.partial = True
                    products.partial_error = str(exc)
                    logger.warning(
                        "%s/%s page %d failed (%s); keeping %d products as partial",
                        site.site_name,
                        category.name,
                        page,
                        exc,
                        len(products),
                        extra={"component": "scraper"},
                    )
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
                if detected_pages and detected_pages <= page_limit:
                    page_limit = detected_pages
                    limit_confirmed = True

            try:
                raw_products, fallback_state = await self._apply_extraction_fallback(site, raw_products, fallback_state)
            except CrawlError as exc:
                # Failed LLM fallback keeps good pages already scraped.
                # The current page had no usable products, so discard it and
                # keep previous pages as partial (never extend with broken).
                if products:
                    products.partial = True
                    products.partial_error = str(exc)
                    logger.warning(
                        "%s/%s LLM fallback failed on page %d (%s); keeping %d products as partial",
                        site.site_name,
                        category.name,
                        page,
                        exc,
                        len(products),
                        extra={"component": "scraper"},
                    )
                    break
                raise
            products.extend(raw_products)
            if on_page:
                on_page(page, raw_products, html)
            if self.delay_ms > 0 and page < page_limit:
                await asyncio.sleep(self.delay_ms / 1000)
            page += 1
        else:
            # Loop ran out of pages rather than hitting end-of-listing. Unless
            # pagination confirmed the count, later pages were never seen, so
            # this snapshot must not retire rows (partial, not complete).
            if products and not limit_confirmed and not products.partial:
                products.partial = True
                products.partial_error = f"stopped at page limit {page_limit} before end of listing"
        return products

    async def crawl_search(
        self,
        site: SiteConfig,
        category: CategoryConfig,
        terms: list[str],
        term_limit: int,
        on_page: Callable[[int, list[RawProduct], str], None] | None = None,
    ) -> CrawlProducts:
        products = CrawlProducts()
        fallback_state = ExtractionFallbackState()
        one_page_site = replace(site, scraping_type="category")
        limited_terms = terms[:term_limit]
        empty_fetched = False
        for index, term in enumerate(limited_terms, start=1):
            is_empty_term = not term or not term.strip()
            if is_empty_term:
                # Empty terms never fail the job. The first empty term costs
                # at most one fetch per engine; repeats are skipped entirely.
                if empty_fetched:
                    if on_page:
                        on_page(index, [], "")
                    continue
                empty_fetched = True
                url = search_page_url(site, category, term or "")
                try:
                    html, raw_products = await self._fetch_and_extract(
                        url, one_page_site, 1, retries=1
                    )
                except CrawlError as exc:
                    logger.warning(
                        "%s search empty term %d skipped (%s)",
                        site.site_name,
                        index,
                        exc,
                        extra={"component": "scraper"},
                    )
                    if on_page:
                        on_page(index, [], "")
                    continue
                if raw_products:
                    try:
                        raw_products, fallback_state = await self._apply_extraction_fallback(site, raw_products, fallback_state)
                    except CrawlError as exc:
                        # raw_products are the failed, price-less items: never
                        # keep them (mirrors crawl_category).
                        if products:
                            products.partial = True
                            products.partial_error = str(exc)
                        if on_page:
                            on_page(index, [], html)
                        continue
                    products.extend(raw_products)
                if on_page:
                    on_page(index, raw_products, html)
                if self.delay_ms > 0 and index < len(limited_terms):
                    await asyncio.sleep(self.delay_ms / 1000)
                continue
            url = search_page_url(site, category, term)
            try:
                html, raw_products = await self._fetch_and_extract(url, one_page_site, 1)
            except CrawlError:
                if index > 1:
                    # Later-term failure keeps earlier terms: partial, not failed.
                    if products:
                        products.partial = True
                        products.partial_error = f"search term {index} failed"
                    continue
                raise
            if raw_products:
                try:
                    raw_products, fallback_state = await self._apply_extraction_fallback(site, raw_products, fallback_state)
                except CrawlError as exc:
                    # Keep earlier terms as partial but never the failed,
                    # price-less items of this term (mirrors crawl_category).
                    if products:
                        products.partial = True
                        products.partial_error = str(exc)
                        if on_page:
                            on_page(index, [], html)
                        continue
                    raise
                products.extend(raw_products)
            if on_page:
                on_page(index, raw_products, html)
            if self.delay_ms > 0 and index < len(limited_terms):
                await asyncio.sleep(self.delay_ms / 1000)
        return products
