"""PR #24 review fixes: listing end, search null prices, job status, prices, timeouts."""
from __future__ import annotations

import asyncio
import io
import sqlite3
import time
import urllib.error
import urllib.request
from typing import Any

import pytest

from scraper import __main__ as cli
from scraper.__main__ import JobOutcome, make_product, run_exit_code, summarize_run
from scraper.crawler import CrawlError, CrawlProducts, Crawl4AIFetcher, HttpStatusError, ScraperCrawler, validate_llm_items
from scraper.models import BrowserConfig, CategoryConfig, RawProduct, SiteConfig
from scraper.normalizer import RegistryMatcher, parse_price


def _site(**overrides: Any) -> SiteConfig:
    base = {
        "site_name": "Shop",
        "base_url": "https://example.com/",
        "scraping_type": "category",
        "browser_config": BrowserConfig(),
        "categories": {},
        "selectors": {"product_container": ".product", "title": ".title", "price": ".price", "url": "a"},
        "country_code": "IN",
        "currency": "INR",
        "engine": "http",
    }
    base.update(overrides)
    return SiteConfig(**base)


def _cat(**overrides: Any) -> CategoryConfig:
    base = {"name": "gpu", "path": "/gpu/", "max_pages": 20, "pagination_pattern": "page/{page}/"}
    base.update(overrides)
    return CategoryConfig(**base)


def _html(title: str, href: str, price: str = "₹100") -> str:
    return (
        f"<div class='product'><span class='title'>{title}</span>"
        f"<span class='price'>{price}</span><a href='{href}'>View</a></div>"
    )


class _PageFetcher:
    """Dual-engine fake: page -> html, or page -> exception raised by both engines."""

    def __init__(self, pages: dict[int, str | Exception]) -> None:
        self.pages = pages
        self.calls: list[str] = []

    def _serve(self, url: str) -> str:
        self.calls.append(url)
        page = int(url.rstrip("/").split("/")[-1]) if "/page/" in url else 1
        value = self.pages.get(page, "")
        if isinstance(value, Exception):
            raise value
        return value

    async def fetch_http(self, url: str, site: SiteConfig, retries: int = 2) -> str:
        return self._serve(url)

    async def fetch_browser(self, url: str, site: SiteConfig, retries: int = 2) -> str:
        return self._serve(url)


def _crawl(pages: dict[int, str | Exception], page_limit: int = 20) -> CrawlProducts:
    crawler = ScraperCrawler(fetcher=_PageFetcher(pages), delay_ms=0, llm_enabled=False)  # type: ignore[arg-type]
    return asyncio.run(crawler.crawl_category(_site(), _cat(), page_limit=page_limit))


# --- Item 2: page 2+ 404/410 or empty page is end of listing -----------------


@pytest.mark.parametrize("status", [404, 410])
def test_single_page_category_with_page2_not_found_is_complete(status: int) -> None:
    # No pagination links on page 1 -> page_limit stays 20; WooCommerce 404s /page/2/.
    products = _crawl({1: _html("GPU A", "/a") + _html("GPU B", "/b"), 2: HttpStatusError("u", status)})
    assert [p.title for p in products] == ["GPU A", "GPU B"]
    assert products.partial is False


def test_empty_but_valid_page2_is_end_of_listing() -> None:
    products = _crawl({1: _html("GPU A", "/a"), 2: "<html><body>No products found</body></html>"})
    assert len(products) == 1
    assert products.partial is False


def test_page2_server_error_is_still_partial() -> None:
    products = _crawl({1: _html("GPU A", "/a"), 2: CrawlError("HTTP Error 503")})
    assert len(products) == 1
    assert products.partial is True


def test_reaching_unconfirmed_page_limit_is_partial() -> None:
    # Pages keep coming and pagination never said how many: unseen pages remain.
    pages: dict[int, str | Exception] = {n: _html(f"GPU {n}", f"/g{n}") for n in range(1, 4)}
    products = _crawl(pages, page_limit=3)
    assert len(products) == 3
    assert products.partial is True


def test_fetch_http_surfaces_404_without_retry_or_browser_fallback(monkeypatch) -> None:
    calls: list[str] = []

    def _raise_404(req: urllib.request.Request, timeout: float = 15) -> None:
        calls.append(req.full_url)
        raise urllib.error.HTTPError(req.full_url, 404, "Not Found", {}, io.BytesIO(b""))  # type: ignore[arg-type]

    monkeypatch.setattr(urllib.request, "urlopen", _raise_404)
    fetcher = Crawl4AIFetcher()

    async def _no_browser(*_args: object, **_kwargs: object) -> str:
        raise AssertionError("browser fallback must not run on a definitive 404")

    monkeypatch.setattr(fetcher, "fetch_browser", _no_browser)
    with pytest.raises(HttpStatusError) as info:
        asyncio.run(fetcher.fetch(("https://example.com/gpu/page/2/"), _site(), retries=3))
    assert info.value.status == 404
    assert len(calls) == 1


# --- Item 3: search never keeps failed, price-less items ---------------------


def test_search_fallback_failure_never_keeps_priceless_items() -> None:
    good = _html("RTX 4070", "/rtx4070")
    broken = "<div class='product'><span class='title'>RTX 4080</span><a href='/rtx4080'>x</a></div>"

    class _Search:
        # Single-engine fetcher: no page validation, so the price-less item
        # reaches the LLM fallback, which then fails.
        async def fetch(self, url: str, site: SiteConfig, retries: int = 2) -> str:
            return broken if "4080" in url else good

    class _FailingLLM:
        def extract_products(self, blocks: list[str]) -> list[dict[str, Any]]:
            return []

    crawler = ScraperCrawler(
        fetcher=_Search(), delay_ms=0, selector_failure_threshold=1,  # type: ignore[arg-type]
        llm_client=_FailingLLM(), llm_enabled=True,  # type: ignore[arg-type]
    )
    site = _site(scraping_type="search")
    products = asyncio.run(crawler.crawl_search(site, _cat(search_pattern="/?s={query}"), ["RTX 4070", "RTX 4080"], 2))
    assert [p.title for p in products] == ["RTX 4070"]
    assert all(p.price_text for p in products)
    assert products.partial is True


def test_make_product_drops_listing_without_price() -> None:
    matcher = RegistryMatcher()
    call_for_price = RawProduct(title="RTX 4090", price_text="Call for price", url="https://example.com/x", image_url=None, in_stock=True)
    zero = RawProduct(title="RTX 4090", price_text="₹0", url="https://example.com/y", image_url=None, in_stock=True)
    priced = RawProduct(title="RTX 4090", price_text="₹1,50,000", url="https://example.com/z", image_url=None, in_stock=True)
    assert make_product(call_for_price, _site(), "gpu", matcher, "2026-09-28T00:00:00Z") is None
    assert make_product(zero, _site(), "gpu", matcher, "2026-09-28T00:00:00Z") is None
    product = make_product(priced, _site(), "gpu", matcher, "2026-09-28T00:00:00Z")
    assert product is not None and product.price == 150000.0


# --- Item 5: price parsing -----------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("45,000 (10% off)", 45000.0),  # no sign: first number
        ("45000", 45000.0),
        ("Save 10% ₹45,000", 45000.0),  # sign present: anchored number
        ("₹39,999 ₹45,000", 39999.0),  # discounted price listed first
        ("Rs. 12,499.50", 12499.5),
        ("12,499 INR", 12499.0),
        ("Call for price", None),
    ],
)
def test_parse_price_formats(text: str, expected: float | None) -> None:
    assert parse_price(text) == expected


# --- Item 6: LLM item validation ------------------------------------------------


def test_validate_llm_items_rejects_bad_scheme_bool_and_nonpositive_price() -> None:
    items = [
        {"title": "ok", "price": 100, "url": "https://example.com/ok", "in_stock": True},
        {"title": "js", "price": 100, "url": "javascript://example.com/x", "in_stock": True},
        {"title": "bool", "price": True, "url": "https://example.com/b", "in_stock": True},
        {"title": "zero", "price": 0, "url": "https://example.com/z", "in_stock": True},
        {"title": "neg", "price": -5, "url": "https://example.com/n", "in_stock": True},
        {"title": "nan", "price": float("nan"), "url": "https://example.com/nan", "in_stock": True},
    ]
    assert [item["title"] for item in validate_llm_items(items, "https://example.com/")] == ["ok"]


# --- Item 8: partial runs are reported apart from failures ----------------------


def test_lone_partial_job_is_partial_and_exits_zero() -> None:
    outcome = summarize_run([JobOutcome("partial", products_written=12, error="Shop/gpu: partial", partial=True)])
    assert outcome.status == "partial"
    assert outcome.jobs_partial == 1
    assert outcome.jobs_failed == 0
    assert run_exit_code(outcome) == 0


def test_partial_without_rows_and_all_failed_exit_nonzero() -> None:
    assert run_exit_code(summarize_run([JobOutcome("partial", products_written=0, partial=True)])) == 1
    assert run_exit_code(summarize_run([JobOutcome("failed", error="x")])) == 1
    assert run_exit_code(summarize_run([JobOutcome("succeeded", 3)])) == 0


# --- Item 1: job outcomes land in the catalog DB --------------------------------


class _FakeCrawler:
    """Stands in for ScraperCrawler inside run_scrape: one scripted result per category."""

    results: dict[str, CrawlProducts | Exception] = {}

    def __init__(self, **_kwargs: object) -> None:
        class _Fetcher:
            async def __aenter__(self) -> "_Fetcher":
                return self

            async def __aexit__(self, *args: object) -> None:
                return None

        self.fetcher = _Fetcher()

    async def crawl_category(self, site: SiteConfig, category: CategoryConfig, limit: int, on_page=None) -> CrawlProducts:
        result = self.results[category.name]
        if isinstance(result, Exception):
            raise result
        return result


def _products(*names: str, partial: bool = False) -> CrawlProducts:
    products = CrawlProducts()
    for name in names:
        products.append(RawProduct(title=name, price_text="₹1,000", url=f"https://example.com/{name}", image_url=None, in_stock=True))
    products.partial = partial
    return products


def test_run_scrape_records_job_status_per_scope(monkeypatch, tmp_path) -> None:
    site = _site()
    work = [(site, _cat(name="gpu"), 5), (site, _cat(name="cpu"), 5), (site, _cat(name="psu"), 5)]
    _FakeCrawler.results = {
        "gpu": _products("gpu-a", "gpu-b"),
        "cpu": _products("cpu-a", partial=True),
        "psu": CrawlError("blocked"),
    }
    monkeypatch.setattr(cli, "build_work", lambda _profile, _args: (work, None))
    monkeypatch.setattr(cli, "ScraperCrawler", _FakeCrawler)
    db = tmp_path / "catalog.db"
    args = cli.build_parser().parse_args(["--profile", "india", "--db", str(db), "--no-llm-fallback", "--delay-ms", "0"])

    code = asyncio.run(cli.run_scrape(args, cli.EventEmitter(False)))

    rows = sqlite3.connect(db).execute("SELECT country_code, retailer, category, status FROM scrape_jobs ORDER BY category").fetchall()
    assert rows == [("IN", "Shop", "cpu", "partial"), ("IN", "Shop", "gpu", "complete"), ("IN", "Shop", "psu", "failed")]
    assert code == 0  # rows were written; the publisher only sweeps gpu


# --- Item 9: crawl_page budget covers teardown ----------------------------------


def test_crawl_page_budget_covers_hung_teardown(monkeypatch) -> None:
    from scraper import crawl_page

    monkeypatch.setattr(crawl_page, "CRAWL_PAGE_CANCEL_GRACE_S", 0.2)

    released = False

    class _HungTeardown:
        async def __aenter__(self) -> "_HungTeardown":
            return self

        async def __aexit__(self, *args: object) -> None:
            # Ignores cancellation, like a stuck browser close.
            end = time.monotonic() + 5
            while time.monotonic() < end and not released:
                try:
                    await asyncio.sleep(0.05)
                except asyncio.CancelledError:
                    continue

        async def fetch_http(self, url: str, site: SiteConfig, retries: int = 1) -> str:
            return "<html>ok</html>"

    async def _run() -> None:
        deadline = time.monotonic() + 0.3
        with pytest.raises(crawl_page.CrawlPageTimeout):
            await crawl_page._crawl_within("https://example.com/", _site(), deadline, fetcher_factory=_HungTeardown)

    started = time.monotonic()
    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(_run())
        elapsed = time.monotonic() - started
    finally:
        # main() hard-exits here; the test instead releases the stuck
        # teardown so the loop closes cleanly.
        released = True
        loop.run_until_complete(asyncio.sleep(0.1))
        loop.close()
    assert elapsed < 1.5
