from __future__ import annotations

import asyncio
import sys
from typing import Any
from types import SimpleNamespace

from scraper.crawler import Crawl4AIFetcher, ScraperCrawler
from scraper.models import BrowserConfig, CategoryConfig, SiteConfig


class FakeFetcher:
    def __init__(self, pages: list[str]) -> None:
        self.pages = pages
        self.urls: list[str] = []

    async def fetch(self, url: str, site: SiteConfig) -> str:
        self.urls.append(url)
        return self.pages[len(self.urls) - 1]


class FakeLLMClient:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def extract_products(self, product_blocks: list[str]) -> list[dict[str, Any]]:
        self.calls.append(product_blocks)
        return [
            {
                "title": "Recovered GPU",
                "price_text": "100",
                "url": "/recovered",
                "image_url": None,
                "in_stock": True,
            }
        ]


def site_config() -> SiteConfig:
    return SiteConfig(
        site_name="Shop",
        base_url="https://example.com/",
        scraping_type="search",
        browser_config=BrowserConfig(),
        categories={},
        selectors={"product_container": ".product", "title": ".title", "price": ".price", "url": "a"},
        country_code="IN",
        currency="INR",
    )


def category_config() -> CategoryConfig:
    return CategoryConfig(name="gpu", path="/search", max_pages=10, search_pattern="/search?q={query}")


def product_html(title: str, href: str) -> str:
    return f"<div class='product'><span class='title'>{title}</span><span class='price'>100</span><a href='{href}'>View</a></div>"


def test_crawl_search_limits_fetched_term_pages_not_product_count() -> None:
    fetcher = FakeFetcher(
        [
            product_html("GPU 1", "/1") + product_html("GPU 2", "/2"),
            product_html("GPU 3", "/3"),
        ]
    )
    crawler = ScraperCrawler(fetcher=fetcher, delay_ms=0, llm_enabled=False)

    products = asyncio.run(crawler.crawl_search(site_config(), category_config(), ["one", "two", "three"], term_limit=2))

    assert [product.title for product in products] == ["GPU 1", "GPU 2", "GPU 3"]
    assert fetcher.urls == ["https://example.com/search?q=one", "https://example.com/search?q=two"]


def test_crawl_search_uses_llm_fallback_after_selector_failures() -> None:
    fetcher = FakeFetcher(["<div class='product'><a href='/broken'>View</a></div>"])
    llm_client = FakeLLMClient()
    crawler = ScraperCrawler(
        fetcher=fetcher,
        delay_ms=0,
        selector_failure_threshold=1,
        llm_client=llm_client,
        llm_enabled=True,
    )

    products = asyncio.run(crawler.crawl_search(site_config(), category_config(), ["broken"], term_limit=1))

    assert [product.title for product in products] == ["Recovered GPU"]
    assert products[0].url == "https://example.com/recovered"
    assert len(llm_client.calls) == 1


def test_crawl_search_buffers_early_selector_failures_for_llm_fallback() -> None:
    fetcher = FakeFetcher([
        "<div class='product'><a href='/broken-one'>View</a></div>",
        "<div class='product'><a href='/broken-two'>View</a></div>",
    ])
    llm_client = FakeLLMClient()
    crawler = ScraperCrawler(
        fetcher=fetcher,
        delay_ms=0,
        selector_failure_threshold=2,
        llm_client=llm_client,
        llm_enabled=True,
    )

    products = asyncio.run(crawler.crawl_search(site_config(), category_config(), ["one", "two"], term_limit=2))

    assert [product.title for product in products] == ["Recovered GPU"]
    assert len(llm_client.calls) == 1
    assert len(llm_client.calls[0]) == 2
    assert "broken-one" in llm_client.calls[0][0]
    assert "broken-two" in llm_client.calls[0][1]


def test_crawl4ai_fetcher_caches_crawlers_by_headless_config(monkeypatch) -> None:
    opened_headless: list[bool] = []
    closed_headless: list[bool] = []

    class FakeBrowserConfig:
        def __init__(self, headless: bool, **kwargs: Any) -> None:
            self.headless = headless

    class FakeCrawlerRunConfig:
        def __init__(self, **kwargs: Any) -> None:
            self.kwargs = kwargs

    class FakeCrawler:
        def __init__(self, headless: bool) -> None:
            self.headless = headless
            self.urls: list[str] = []

        async def arun(self, url: str, config: FakeCrawlerRunConfig) -> SimpleNamespace:
            self.urls.append(url)
            return SimpleNamespace(success=True, html=f"<html>{self.headless}:{url}</html>")

    class FakeAsyncWebCrawler:
        def __init__(self, config: FakeBrowserConfig) -> None:
            self.config = config
            self.crawler = FakeCrawler(config.headless)

        async def __aenter__(self) -> FakeCrawler:
            opened_headless.append(self.config.headless)
            return self.crawler

        async def __aexit__(self, *args: object) -> None:
            closed_headless.append(self.config.headless)

    monkeypatch.setitem(
        sys.modules,
        "crawl4ai",
        SimpleNamespace(
            AsyncWebCrawler=FakeAsyncWebCrawler,
            BrowserConfig=FakeBrowserConfig,
            CacheMode=SimpleNamespace(BYPASS="bypass"),
            CrawlerRunConfig=FakeCrawlerRunConfig,
        ),
    )
    headless_site = site_config()
    headed_site = SiteConfig(
        **{
            **headless_site.__dict__,
            "browser_config": BrowserConfig(headless=False),
        }
    )
    fetcher = Crawl4AIFetcher()

    async def run_fetches() -> tuple[str, str, str]:
        first = await fetcher.fetch("https://example.com/first", headless_site)
        second = await fetcher.fetch("https://example.com/second", headed_site)
        third = await fetcher.fetch("https://example.com/third", headless_site)
        await fetcher.close()
        return first, second, third

    first, second, third = asyncio.run(run_fetches())

    assert first == "<html>True:https://example.com/first</html>"
    assert second == "<html>False:https://example.com/second</html>"
    assert third == "<html>True:https://example.com/third</html>"
    assert opened_headless == [True, False]
    assert closed_headless == [True, False]
