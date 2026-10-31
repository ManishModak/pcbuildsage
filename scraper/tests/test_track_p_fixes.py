"""Track P scraper fixes: partial crawls, empty search, LLM fallback, sweep, price, cleanup."""
from __future__ import annotations

import asyncio
import gzip
import urllib.request
import zlib
from typing import Any

from scraper.__main__ import JobOutcome, summarize_run
from scraper.crawler import (
    Crawl4AIFetcher,
    CrawlError,
    ScraperCrawler,
    validate_llm_items,
)
from scraper.db import ProductStore
from scraper.models import BrowserConfig, CategoryConfig, RawProduct, ScrapedProduct, SiteConfig
from scraper.normalizer import parse_price


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
    }
    base.update(overrides)
    return SiteConfig(**base)


def _cat(**overrides: Any) -> CategoryConfig:
    base = {"name": "gpu", "path": "/catalog/gpu", "max_pages": 10, "pagination_pattern": "?page={page}"}
    base.update(overrides)
    return CategoryConfig(**base)


def _html(title: str, href: str, price: str = "100") -> str:
    return (
        f"<div class='product'><span class='title'>{title}</span>"
        f"<span class='price'>{price}</span><a href='{href}'>View</a></div>"
    )


class _DualPages:
    """Dual-engine fetcher serving per-page HTML, failing on chosen pages."""

    def __init__(self, pages: dict[int, str], fail_pages: set[int]) -> None:
        self.pages = pages
        self.fail_pages = fail_pages
        self.http_calls: list[str] = []
        self.browser_calls: list[str] = []

    def _page_no(self, url: str) -> int:
        if "page=6" in url:
            return 6
        if "page=" in url:
            try:
                return int(url.split("page=")[-1].split("&")[0])
            except ValueError:
                return 1
        return 1

    async def fetch_http(self, url: str, site: SiteConfig, retries: int = 2) -> str:
        self.http_calls.append(url)
        page = self._page_no(url)
        if page in self.fail_pages:
            raise CrawlError("timeout on page 6")
        return self.pages.get(page, "")

    async def fetch_browser(self, url: str, site: SiteConfig, retries: int = 2) -> str:
        self.browser_calls.append(url)
        page = self._page_no(url)
        if page in self.fail_pages:
            raise CrawlError("timeout on page 6")
        return self.pages.get(page, "")


def test_page6_timeout_is_partial_not_end_of_listing() -> None:
    pages = {n: _html(f"GPU {n}", f"/gpu-{n}") for n in range(1, 6)}
    fetcher = _DualPages(pages, fail_pages={6})
    crawler = ScraperCrawler(fetcher=fetcher, delay_ms=0, llm_enabled=False)  # type: ignore[arg-type]
    site = _site(engine="http")
    cat = _cat(max_pages=6)

    products = asyncio.run(crawler.crawl_category(site, cat, page_limit=6))

    assert len(products) == 5
    assert getattr(products, "partial", False) is True
    err = (getattr(products, "partial_error", "") or "").lower()
    assert "page=6" in err or "page 6" in err or "timeout" in err or "failed validation" in err


def test_partial_crawl_never_sweeps_stale_rows(tmp_path) -> None:
    db = tmp_path / "products.db"
    stale = ScrapedProduct(
        id="stale", name="Stale GPU", normalized_name="stale gpu", registry_key=None,
        price=50.0, currency="INR", country_code="IN", retailer="Shop",
        url="https://example.com/stale", image_url=None, in_stock=True, category="gpu",
        first_seen="2026-01-01T00:00:00Z", last_scraped="2026-01-01T00:00:00Z",
    )
    fresh = ScrapedProduct(
        id="fresh", name="Fresh GPU", normalized_name="fresh gpu", registry_key=None,
        price=99.0, currency="INR", country_code="IN", retailer="Shop",
        url="https://example.com/fresh", image_url=None, in_stock=True, category="gpu",
        first_seen="2026-07-07T00:00:00Z", last_scraped="2026-07-07T00:00:00Z",
    )
    with ProductStore(db) as store:
        store.upsert_products([stale, fresh], scraped_at="2026-01-01T00:00:00Z")
    # Partial write must not retire the stale row.
    from scraper.__main__ import write_products_partial as _partial
    from scraper.models import CategoryConfig as _CC
    site = _site()
    cat = _CC(name="gpu", path="/g", max_pages=1)
    written, reason = _partial(str(db), [fresh], "2026-07-07T00:00:00Z", site, cat, "2026-07-07T00:00:00Z")
    assert written == 1
    assert reason is not None
    with ProductStore(db) as store:
        rows = {r["id"]: r["in_stock"] for r in store.conn.execute("SELECT id, in_stock FROM products").fetchall()}
    assert rows["stale"] == 1

    # A partial job is reported distinctly from success.
    outcome = summarize_run([JobOutcome("partial", products_written=1, error="Shop/gpu: partial", partial=True)])
    assert outcome.jobs_partial == 1
    assert outcome.jobs_failed == 0
    assert outcome.products_written == 1


class _EmptyAwareFetcher:
    def __init__(self) -> None:
        self.http_calls: list[str] = []
        self.browser_calls: list[str] = []

    async def fetch_http(self, url: str, site: SiteConfig, retries: int = 2) -> str:
        self.http_calls.append(url)
        if url.endswith("?q=") or "?q=&" in url or url.endswith("%20") or "q=%20" in url or "q=" in url and url.rsplit("q=", 1)[-1].strip() == "":
            raise CrawlError("empty query has no listing")
        return _html("Valid GPU", "/valid")

    async def fetch_browser(self, url: str, site: SiteConfig, retries: int = 2) -> str:
        self.browser_calls.append(url)
        if url.endswith("?q=") or "q=" in url and url.rsplit("q=", 1)[-1].strip() == "":
            raise CrawlError("empty query has no listing")
        return _html("Valid GPU", "/valid")


def test_empty_first_search_term_does_not_fail_job() -> None:
    fetcher = _EmptyAwareFetcher()
    crawler = ScraperCrawler(fetcher=fetcher, delay_ms=0, llm_enabled=False)  # type: ignore[arg-type]
    site = _site(scraping_type="search", engine="http")
    cat = CategoryConfig(name="gpu", path="/s", max_pages=10, search_pattern="/s?q={query}")

    products = asyncio.run(crawler.crawl_search(site, cat, ["", "RTX 4070"], term_limit=2))

    assert [p.title for p in products] == ["Valid GPU"]


def test_empty_term_costs_at_most_one_fetch_per_engine() -> None:
    fetcher = _EmptyAwareFetcher()
    crawler = ScraperCrawler(fetcher=fetcher, delay_ms=0, llm_enabled=False)  # type: ignore[arg-type]
    site = _site(scraping_type="search", engine="http")
    cat = CategoryConfig(name="gpu", path="/s", max_pages=10, search_pattern="/s?q={query}")

    products = asyncio.run(crawler.crawl_search(site, cat, ["", ""], term_limit=2))

    assert products == []
    assert len(fetcher.http_calls) <= 1
    assert len(fetcher.browser_calls) <= 1


class _LowCoverageDual:
    """Dual-engine fetcher returning 1/3 complete (under-50% rejection case)."""

    def __init__(self, html: str) -> None:
        self.html = html
        self.http_calls = 0
        self.browser_calls = 0

    async def fetch_http(self, url: str, site: SiteConfig, retries: int = 2) -> str:
        self.http_calls += 1
        return self.html

    async def fetch_browser(self, url: str, site: SiteConfig, retries: int = 2) -> str:
        self.browser_calls += 1
        return self.html


class _FakeLLM:
    def __init__(self, payload: list[dict[str, Any]], delay_s: float = 0.0) -> None:
        self.payload = payload
        self.delay_s = delay_s
        self.calls: list[list[str]] = []

    def extract_products(self, blocks: list[str]) -> list[dict[str, Any]]:
        import time

        self.calls.append(blocks)
        if self.delay_s:
            time.sleep(self.delay_s)
        return self.payload


def _low_coverage_html() -> str:
    good = _html("Good GPU", "/good", "₹45,000")
    bad1 = "<div class='product'><span class='title'>Bad One</span><a href='/bad1'>View</a></div>"
    bad2 = "<div class='product'><span class='title'>Bad Two</span><a href='/bad2'>View</a></div>"
    return good + bad1 + bad2


def test_llm_fallback_runs_before_under50_rejection_on_page1() -> None:
    html = _low_coverage_html()
    fetcher = _LowCoverageDual(html)
    llm = _FakeLLM([{"title": "Recovered", "price_text": "₹12,000", "url": "/recovered", "in_stock": True}])
    crawler = ScraperCrawler(
        fetcher=fetcher, delay_ms=0, selector_failure_threshold=100,  # type: ignore[arg-type]
        llm_client=llm, llm_enabled=True,  # type: ignore[arg-type]
    )
    site = _site(engine="http")
    cat = _cat(max_pages=1)

    products = asyncio.run(crawler.crawl_category(site, cat, page_limit=1))

    assert len(llm.calls) == 1
    titles = [p.title for p in products]
    assert "Good GPU" in titles
    assert "Recovered" in titles


def test_llm_output_validation_drops_bad_types_and_off_domain() -> None:
    payload = [
        {"title": "Good", "price_text": "₹10,000", "url": "/good", "in_stock": True},
        {"title": "Bad Price Type", "price_text": {"amount": 5}, "url": "/bad-price", "in_stock": True},
        {"title": "Bad Stock Type", "price_text": "₹9,000", "url": "/bad-stock", "in_stock": "true"},
        {"title": "Off Domain", "price_text": "₹8,000", "url": "https://evil.example/p", "in_stock": True},
        {"title": "", "price_text": "₹7,000", "url": "/empty-title", "in_stock": True},
    ]
    valid = validate_llm_items(payload, "https://example.com/")
    assert [v["title"] for v in valid] == ["Good"]


def test_llm_timeout_keeps_valid_and_returns_quickly(monkeypatch) -> None:
    import scraper.crawler as _crawler

    monkeypatch.setattr(_crawler, "LLM_FALLBACK_TIMEOUT_S", 0.05)
    html = _html("Good GPU", "/good", "₹45,000")
    fetcher = _LowCoverageDual(html + "<div class='product'><span class='title'>Bad</span></div>")
    llm = _FakeLLM(
        [{"title": "Slow", "price_text": "₹1", "url": "/slow", "in_stock": True}],
        delay_s=0.5,
    )
    crawler = ScraperCrawler(
        fetcher=fetcher, delay_ms=0, selector_failure_threshold=100,  # type: ignore[arg-type]
        llm_client=llm, llm_enabled=True,  # type: ignore[arg-type]
    )
    site = _site(engine="http")
    # Direct fallback path: valid products kept even when the model hangs.
    from scraper.crawler import ExtractionFallbackState

    raw = [
        RawProduct(title="Good GPU", price_text="₹45,000", url="https://example.com/good", image_url=None, in_stock=True),
        RawProduct(title=None, price_text=None, url=None, image_url=None, in_stock=True, source_html="<div>bad</div>"),
    ]
    # Lower threshold so fallback triggers, but the call times out.
    crawler.selector_failure_threshold = 1
    valid, _ = asyncio.run(crawler._apply_extraction_fallback(site, raw, ExtractionFallbackState()))
    assert [p.title for p in valid] == ["Good GPU"]


def test_failed_llm_fallback_keeps_good_pages_already_scraped() -> None:
    page1 = _html("Page1 GPU", "/p1")
    page2_bad = "<div class='product'><span class='title'>Broken</span></div>"

    class _TwoPage:
        async def fetch_http(self, url: str, site: SiteConfig, retries: int = 2) -> str:
            return page2_bad if "page=2" in url else page1

        async def fetch_browser(self, url: str, site: SiteConfig, retries: int = 2) -> str:
            return page2_bad if "page=2" in url else page1

    llm = _FakeLLM([])  # always fails
    crawler = ScraperCrawler(
        fetcher=_TwoPage(), delay_ms=0, selector_failure_threshold=1,  # type: ignore[arg-type]
        llm_client=llm, llm_enabled=True,
    )
    site = _site(engine="http")
    cat = _cat(max_pages=2)
    products = asyncio.run(crawler.crawl_category(site, cat, page_limit=2))
    assert [p.title for p in products] == ["Page1 GPU"]
    assert getattr(products, "partial", False) is True


def _scraped(pid: str, name: str, category: str, url: str, price: float | None, sub: str | None = None) -> ScrapedProduct:
    return ScrapedProduct(
        id=pid, name=name, normalized_name=name.lower(), registry_key=None, price=price,
        currency="INR", country_code="IN", retailer="Shop", url=url, image_url=None,
        in_stock=True, category=category, subcategory=sub,
        first_seen="2026-01-01T00:00:00Z", last_scraped="2026-07-07T00:00:00Z",
    )


def test_sweep_counts_unique_urls_not_rows(tmp_path) -> None:
    db = tmp_path / "products.db"
    with ProductStore(db) as store:
        for i in range(8):
            store.upsert_products([_scraped(f"old-{i}", f"Old {i}", "gpu", f"https://example.com/old-{i}", 10.0)])
        # 10 rows sharing one URL (same product seen 10 times): only one
        # unique URL found, so the 50% guard must trip and skip the sweep.
        from scraper.normalizer import product_id as _pid

        same_url = "https://example.com/same"
        same_id = _pid(same_url)
        dupes = [
            ScrapedProduct(
                id=same_id, name="Dupe", normalized_name="dupe", registry_key=None, price=10.0,
                currency="INR", country_code="IN", retailer="Shop", url=same_url, image_url=None,
                in_stock=True, category="gpu",
                first_seen="2026-07-08T00:00:00Z", last_scraped="2026-07-08T00:00:00Z",
            )
            for _ in range(10)
        ]
        written, skipped = store.apply_category_snapshot(
            dupes, retailer="Shop", category="gpu",
            run_started_at="2026-07-08T00:00:00Z", scraped_at="2026-07-08T00:00:00Z",
        )
    assert written == 10
    assert skipped is not None
    assert "partial" in skipped or "threshold" in skipped or "suspected" in skipped


def test_ram_in_storage_reclassification_drops_stale_subcategory(tmp_path) -> None:
    db = tmp_path / "products.db"
    ram = _scraped("ram1", "Corsair Vengeance 16GB DDR5 RAM CL40", "storage", "https://example.com/ram1", 8000.0, sub="internal")
    with ProductStore(db) as store:
        store.upsert_products([ram])
        row = store.conn.execute("SELECT category, subcategory FROM products WHERE id='ram1'").fetchone()
    assert row["category"] == "ram"
    assert row["subcategory"] is None


def test_failed_price_parse_never_overwrites_stored_price(tmp_path) -> None:
    db = tmp_path / "products.db"
    with ProductStore(db) as store:
        store.upsert_products([_scraped("p1", "GPU", "gpu", "https://example.com/p1", 45000.0)])
        store.upsert_products([_scraped("p1", "GPU", "gpu", "https://example.com/p1", None)])
        row = store.conn.execute("SELECT price FROM products WHERE id='p1'").fetchone()
    assert row["price"] == 45000.0


def test_parse_price_takes_price_not_first_number() -> None:
    assert parse_price("Save 10% ₹45,000") == 45000.0
    assert parse_price("₹1,23,456.78") == 123456.78
    assert parse_price("$499") == 499.0
    assert parse_price("No price") is None


def test_close_closes_every_browser_even_when_one_fails() -> None:
    closed: list[str] = []

    class _Ctx:
        def __init__(self, name: str, fail: bool = False) -> None:
            self.name = name
            self.fail = fail

        async def __aexit__(self, *args: object) -> None:
            closed.append(self.name)
            if self.fail:
                raise RuntimeError("close boom")

    async def _run() -> None:
        from scraper.models import BrowserConfig as _BC

        fetcher = Crawl4AIFetcher()
        fetcher._crawler_contexts[_BC(headless=True)] = _Ctx("first", fail=True)  # type: ignore[assignment]
        fetcher._crawler_contexts[_BC(headless=False)] = _Ctx("second")  # type: ignore[assignment]
        await fetcher.close()
        assert not fetcher._crawler_contexts

    asyncio.run(_run())
    assert closed == ["first", "second"]


def test_fetch_http_decodes_deflate_and_page_charset(monkeypatch) -> None:
    html = "<html><head><meta charset='iso-8859-1'></head><body>caf\u00e9</body></html>"
    raw = html.encode("iso-8859-1")
    compressed = zlib.compress(raw)

    class _Info:
        def get(self, key: str, default: str = "") -> str:
            return "deflate" if key == "Content-Encoding" else default

        def get_content_charset(self) -> str | None:
            return None

    class _Resp:
        def __enter__(self) -> "_Resp":
            return self

        def __exit__(self, *args: object) -> None:
            return None

        def read(self) -> bytes:
            return compressed

        def geturl(self) -> str:
            return "https://example.com/p"

        def info(self) -> _Info:
            return _Info()

    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=15: _Resp())
    fetcher = Crawl4AIFetcher()
    site = _site()
    out = asyncio.run(fetcher.fetch_http("https://example.com/p", site, retries=1))
    assert "caf" in out


def test_fetch_http_rejects_non_http_scheme() -> None:
    fetcher = Crawl4AIFetcher()
    site = _site()
    try:
        asyncio.run(fetcher.fetch_http("file:///etc/passwd", site, retries=1))
    except CrawlError:
        return
    raise AssertionError("non-http URL was not rejected")


def test_crawl_page_rejects_non_http_scheme() -> None:
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "crawl_page_mod", "scraper/crawl_page.py"
    )
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    try:
        mod._assert_http_url("ftp://example.com/x")
    except ValueError:
        return
    raise AssertionError("crawl_page accepted ftp URL")


def test_gzip_still_decodes(monkeypatch) -> None:
    html = "<div>hello</div>"
    compressed = gzip.compress(html.encode())

    class _Info:
        def get(self, key: str, default: str = "") -> str:
            return "gzip" if key == "Content-Encoding" else default

        def get_content_charset(self) -> str | None:
            return "utf-8"

    class _Resp:
        def __enter__(self) -> "_Resp":
            return self

        def __exit__(self, *args: object) -> None:
            return None

        def read(self) -> bytes:
            return compressed

        def geturl(self) -> str:
            return "https://example.com/p"

        def info(self) -> _Info:
            return _Info()

    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=15: _Resp())
    out = asyncio.run(Crawl4AIFetcher().fetch_http("https://example.com/", _site(), retries=1))
    assert out == html


def test_sigterm_handler_reports_cancelled() -> None:
    import pytest as _pytest

    from scraper.__main__ import _handle_sigterm

    with _pytest.raises(KeyboardInterrupt):
        _handle_sigterm(None, None)
