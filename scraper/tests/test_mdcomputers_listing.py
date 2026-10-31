"""MDComputers listing scope and the redirect-to-homepage guard.

MDComputers' retired category paths 302 to the homepage, whose promo carousels
match `.product-grid-item`; those promos were saved under whatever category was
being crawled. Listing pages carry the same carousels beside the real grid.
"""

from __future__ import annotations

import asyncio
import sys
import urllib.request
from types import SimpleNamespace
from typing import Any

import pytest

from scraper.config import load_profile
from scraper.crawler import Crawl4AIFetcher, CrawlError, RedirectedToHomeError, ScraperCrawler
from scraper.extractor import extract_products

BASE = "https://mdcomputers.in/"


def mdcomputers():
    return next(s for s in load_profile("india").sites if s.site_name == "MDComputers")


def grid_item(title: str, slug: str) -> str:
    # Trimmed from the live catalog/cpu-cooler markup (2026-09-30).
    return (
        "<div class='product-grid-item product-hover-icons'><div class='product-wrapper'>"
        f"<a href='{BASE}product/{slug}' class='product-image-link'><img src='/img/{slug}.webp'></a>"
        f"<h3 class='product-entities-title'><a href='{BASE}product/{slug}'>{title}</a></h3>"
        "<span class='price'><span class='ins'><span class='amount'>₹2,750</span></span></span>"
        "</div></div>"
    )


def promo_module(module_id: str, items: str, carousel: bool) -> str:
    inner = f"<div class='owl-carousel'>{items}</div>" if carousel else items
    return (
        f"<div id='module_{module_id}'><div class='retrinapro-productlist-{module_id}'>"
        f"<div class='products elements-grid row'>{inner}</div></div></div>"
    )


def listing_page(main_items: str, promos: str = "") -> str:
    return (
        f"<html><body>{promos}<div class='row all-product-wrapper mb-5'>"
        "<div class='retrinapro-productlist-all_products_design col-lg-3'>"
        f"<div class='products elements-grid product-products-holder'>{main_items}</div>"
        "</div></div></body></html>"
    )


def test_listing_selector_skips_promo_modules() -> None:
    # Storage has an owl carousel and a plain promo grid; both must be skipped.
    html = listing_page(
        grid_item("Arctic Freezer 8i CPU Air Cooler", "freezer-8i")
        + grid_item("Cooler Master Hyper 212 3DHP", "hyper-212"),
        promos=promo_module("6177", grid_item("MSI RTX 5050 Graphics Card", "rtx-5050"), carousel=True)
        + promo_module("6179", grid_item("Synology DS223j NAS", "ds223j"), carousel=False),
    )

    titles = [p.title for p in extract_products(html, mdcomputers().selectors, BASE)]

    assert titles == ["Arctic Freezer 8i CPU Air Cooler", "Cooler Master Hyper 212 3DHP"]


def test_homepage_promos_yield_no_products() -> None:
    home = "<html><body>" + promo_module("3597", grid_item("RTX 5050", "rtx-5050"), carousel=True) + "</body></html>"

    assert extract_products(home, mdcomputers().selectors, BASE) == []


class FakeResponse:
    def __init__(self, final_url: str) -> None:
        self.final_url = final_url

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: object) -> None:
        pass

    def geturl(self) -> str:
        return self.final_url

    def read(self) -> bytes:
        return b"<html>page</html>"

    def info(self) -> Any:
        return SimpleNamespace(get=lambda *a: "", get_content_charset=lambda: "utf-8")


def fake_urlopen(monkeypatch: pytest.MonkeyPatch, final_url: str) -> list[str]:
    calls: list[str] = []

    def urlopen(req: urllib.request.Request, timeout: float) -> FakeResponse:
        calls.append(req.full_url)
        return FakeResponse(final_url)

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    return calls


def test_http_fetch_rejects_redirect_to_homepage_without_retrying(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = fake_urlopen(monkeypatch, f"{BASE}?route=common/home")

    with pytest.raises(RedirectedToHomeError):
        asyncio.run(Crawl4AIFetcher().fetch_http(f"{BASE}catalog/cooling-system", mdcomputers()))

    assert len(calls) == 1


def test_http_fetch_allows_non_home_redirects(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_urlopen(monkeypatch, f"{BASE}catalog/cpu-cooler/")

    html = asyncio.run(Crawl4AIFetcher().fetch_http(f"{BASE}catalog/cpu-cooler", mdcomputers()))

    assert html == "<html>page</html>"


def test_browser_fetch_rejects_redirect_to_homepage(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeCrawler:
        async def arun(self, url: str, config: Any) -> SimpleNamespace:
            return SimpleNamespace(success=True, status_code=200, html="<html>home</html>", redirected_url=BASE)

    class FakeAsyncWebCrawler:
        def __init__(self, config: Any) -> None:
            pass

        async def __aenter__(self) -> FakeCrawler:
            return FakeCrawler()

        async def __aexit__(self, *args: object) -> None:
            pass

    monkeypatch.setitem(
        sys.modules,
        "crawl4ai",
        SimpleNamespace(
            AsyncWebCrawler=FakeAsyncWebCrawler,
            BrowserConfig=lambda **kwargs: None,
            CacheMode=SimpleNamespace(BYPASS="bypass"),
            CrawlerRunConfig=lambda **kwargs: None,
        ),
    )

    with pytest.raises(RedirectedToHomeError):
        asyncio.run(Crawl4AIFetcher().fetch_browser(f"{BASE}catalog/smps-power-supply", mdcomputers()))


def test_category_crawl_fails_on_homepage_redirect_without_engine_fallback() -> None:
    class RedirectingFetcher:
        def __init__(self) -> None:
            self.browser_calls = 0

        async def fetch_http(self, url: str, site: Any) -> str:
            raise RedirectedToHomeError(url, BASE)

        async def fetch_browser(self, url: str, site: Any) -> str:
            self.browser_calls += 1
            return listing_page(grid_item("Should not be saved", "x"))

    site = mdcomputers()
    fetcher = RedirectingFetcher()
    crawler = ScraperCrawler(fetcher=fetcher, delay_ms=0, llm_enabled=False)

    with pytest.raises(CrawlError, match="redirected to homepage"):
        asyncio.run(crawler.crawl_category(site, site.categories["cooler"], page_limit=1))

    assert fetcher.browser_calls == 0
