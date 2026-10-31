from __future__ import annotations

import asyncio
import json

import pytest

from scraper.config import ProfileError, load_profile
from scraper.crawler import CrawlError, HttpStatusError, ScraperCrawler, shopify_collection_url
from scraper.extractor import raw_from_shopify_products
from scraper.models import BrowserConfig, CategoryConfig, SiteConfig
from scraper import __main__ as cli
from scraper.__main__ import make_product
from scraper.normalizer import RegistryMatcher

BASE = "https://shop.example/"


def variant(price: str, available: bool, compare_at: str | None = None) -> dict:
    return {"price": price, "available": available, "compare_at_price": compare_at}


def item(handle: str, variants: list[dict], images: list[str] | None = None) -> dict:
    return {
        "title": f"Title {handle}",
        "handle": handle,
        "variants": variants,
        "images": [{"src": src} for src in images or []],
    }


def page(*handles: str) -> str:
    return json.dumps({"products": [item(handle, [variant("100.00", True)]) for handle in handles]})


def site() -> SiteConfig:
    return SiteConfig(
        site_name="Shop",
        base_url=BASE,
        scraping_type="shopify_json",
        browser_config=BrowserConfig(),
        categories={},
        selectors={},
        country_code="IN",
        currency="INR",
    )


def category(max_pages: int = 10) -> CategoryConfig:
    return CategoryConfig(name="cpu", path="collections/processor", max_pages=max_pages)


class FakeHttpFetcher:
    """Serves one queued body (or exception) per fetch_http call."""

    def __init__(self, responses: list[str | Exception]) -> None:
        self.responses = responses
        self.urls: list[str] = []

    async def fetch_http(self, url: str, site: SiteConfig) -> str:
        self.urls.append(url)
        response = self.responses[len(self.urls) - 1]
        if isinstance(response, Exception):
            raise response
        return response


async def _no_sleep(_seconds: float) -> None:
    return None


def crawl(responses: list[str | Exception], max_pages: int = 10):
    fetcher = FakeHttpFetcher(responses)
    crawler = ScraperCrawler(fetcher=fetcher, delay_ms=0, llm_enabled=False)
    return fetcher, asyncio.run(crawler.crawl_shopify_collection(site(), category(max_pages), max_pages))


def test_mapping_uses_lowest_available_price_never_compare_at() -> None:
    [raw] = raw_from_shopify_products(
        [
            item(
                "ryzen-5",
                [
                    variant("20000.00", True, compare_at="1.00"),
                    variant("15000.00", False),  # cheaper but sold out: ignored
                    variant("18000.50", True),
                ],
                images=["https://cdn.example/a.jpg", "https://cdn.example/b.jpg"],
            )
        ],
        BASE,
    )

    assert raw.title == "Title ryzen-5"
    assert raw.url == "https://shop.example/products/ryzen-5"
    assert raw.price_text == "18000.50"
    assert raw.in_stock is True
    assert raw.image_url == "https://cdn.example/a.jpg"


def test_mapping_all_sold_out_keeps_lowest_price_and_marks_out_of_stock() -> None:
    [raw] = raw_from_shopify_products([item("x", [variant("500.00", False), variant("400.00", False)])], BASE)

    assert raw.price_text == "400.00"
    assert raw.in_stock is False
    assert raw.image_url is None


def test_mapping_listing_without_usable_price_or_handle_is_unbuyable() -> None:
    raws = raw_from_shopify_products([item("free", [variant("0.00", True)]), {"title": "No handle", "variants": []}], BASE)
    site_config = site()
    made = [make_product(raw, site_config, "cpu", RegistryMatcher(), "2026-01-01T00:00:00Z") for raw in raws]

    assert made == [None, None]


def test_make_product_carries_price_and_stock_from_json() -> None:
    [raw] = raw_from_shopify_products([item("ryzen-5", [variant("12999.00", True)])], BASE)
    product = make_product(raw, site(), "cpu", RegistryMatcher(), "2026-01-01T00:00:00Z")

    assert product is not None
    assert (product.price, product.in_stock, product.url) == (12999.0, True, "https://shop.example/products/ryzen-5")


def test_collection_url_requests_full_pages() -> None:
    assert shopify_collection_url(site(), category(), 3) == "https://shop.example/collections/processor/products.json?limit=250&page=3"


def test_pagination_runs_until_an_empty_page_and_is_complete() -> None:
    fetcher, products = crawl([page("a", "b"), page("c"), json.dumps({"products": []})])

    assert [p.url.rsplit("/", 1)[1] for p in products] == ["a", "b", "c"]
    assert [url.rsplit("page=", 1)[1] for url in fetcher.urls] == ["1", "2", "3"]
    assert products.partial is False


def test_pagination_stopping_at_page_limit_is_partial() -> None:
    _fetcher, products = crawl([page("a"), page("b")], max_pages=2)

    assert len(products) == 2
    assert products.partial is True
    assert "page limit" in (products.partial_error or "")


def test_pagination_repeated_page_is_partial_not_an_endless_loop() -> None:
    fetcher, products = crawl([page("a", "b"), page("a", "b"), page("a", "b")])

    assert len(products) == 2
    assert len(fetcher.urls) == 2
    assert products.partial is True


def test_page_overlapping_earlier_results_is_partial() -> None:
    # A collection that shifted mid-crawl may have pushed a listing past us.
    _fetcher, products = crawl([page("a", "b"), page("b", "c"), json.dumps({"products": []})])

    assert products.partial is True


def test_later_page_failure_keeps_earlier_pages_as_partial() -> None:
    _fetcher, products = crawl([page("a"), HttpStatusError("u", 500)])

    assert len(products) == 1
    assert products.partial is True


def test_transient_non_json_body_is_retried(monkeypatch) -> None:
    monkeypatch.setattr("scraper.crawler.asyncio.sleep", _no_sleep)
    fetcher, products = crawl(["<html>Browser verification</html>", page("a"), json.dumps({"products": []})])

    assert len(products) == 1
    assert fetcher.urls[0] == fetcher.urls[1]
    assert products.partial is False


def test_first_page_failure_or_persistent_non_json_body_fails_the_job(monkeypatch) -> None:
    monkeypatch.setattr("scraper.crawler.asyncio.sleep", _no_sleep)
    with pytest.raises(HttpStatusError):
        crawl([HttpStatusError("u", 404)])
    with pytest.raises(CrawlError, match="did not return JSON"):
        crawl(["<html>Browser verification</html>"] * 3)
    with pytest.raises(CrawlError, match="products list"):
        crawl(['{"errors": "x"}'] * 3)


def shopify_profile(tmp_path, **overrides):
    site_block = {
        "site_name": "Shop",
        "base_url": BASE,
        "scraping_type": "shopify_json",
        "categories": {"cpu": {"path": "collections/processor", "max_pages": 5}},
    }
    site_block.update(overrides)
    path = tmp_path / "p.json"
    path.write_text(
        json.dumps(
            {
                "$schema": "../schemas/profile.schema.json",
                "schema_version": 1,
                "profile_name": "T",
                "country_code": "IN",
                "default_currency": "INR",
                "sites": [site_block],
            }
        ),
        encoding="utf-8",
    )
    return path


def test_shopify_profile_needs_no_selectors_or_browser_config(tmp_path) -> None:
    loaded = load_profile(shopify_profile(tmp_path)).sites[0]

    assert loaded.scraping_type == "shopify_json"
    assert loaded.selectors == {}


def test_shopify_profile_rejects_non_collection_path(tmp_path) -> None:
    bad = {"cpu": {"path": "/cpus?page={page}", "max_pages": 5}}
    with pytest.raises(ProfileError, match="collections/<handle>"):
        load_profile(shopify_profile(tmp_path, categories=bad))


def test_profile_test_fails_when_a_shopify_collection_cannot_be_read(monkeypatch, tmp_path, capsys) -> None:
    async def blocked(self, site, category, limit, on_page=None):
        raise CrawlError("did not return JSON")

    monkeypatch.setattr(ScraperCrawler, "crawl_shopify_collection", blocked)
    args = cli.build_parser().parse_args(["--test-profile", str(shopify_profile(tmp_path)), "--delay-ms", "0"])

    assert asyncio.run(cli.run_test_profile(args, cli.EventEmitter(False))) == 1
    assert "JSON FAIL" in capsys.readouterr().out
