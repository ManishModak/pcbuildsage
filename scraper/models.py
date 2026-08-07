from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class BrowserConfig:
    headless: bool = True
    js_rendering: bool = True
    wait_for_selector: str | None = None
    scroll_down: bool = False
    timeout_ms: int = 30000


@dataclass(frozen=True)
class CategoryConfig:
    name: str
    path: str
    max_pages: int
    pagination_pattern: str | None = None
    search_pattern: str | None = None


@dataclass(frozen=True)
class SiteConfig:
    site_name: str
    base_url: str
    scraping_type: str
    browser_config: BrowserConfig
    categories: dict[str, CategoryConfig]
    selectors: dict[str, str]
    country_code: str
    currency: str
    max_llm_calls_per_site: int | None = None


@dataclass(frozen=True)
class ProfileConfig:
    source_path: str
    schema_version: int
    profile_name: str
    country_code: str
    default_currency: str
    sites: list[SiteConfig]


@dataclass
class ScrapedProduct:
    id: str
    name: str
    normalized_name: str | None
    registry_key: str | None
    price: float | None

    currency: str
    country_code: str
    retailer: str
    url: str
    image_url: str | None
    in_stock: bool
    category: str
    subcategory: str | None = None
    specs: dict[str, Any] = field(default_factory=dict)
    first_seen: str | None = None
    last_scraped: str | None = None


@dataclass(frozen=True)
class RawProduct:
    title: str | None
    price_text: str | None
    url: str | None
    image_url: str | None
    in_stock: bool
    source_html: str = ""


@dataclass
class ScrapeProgress:
    site: str
    category: str | None = None
    page: int = 0
    pages_total: int = 0
    products_seen: int = 0
    percent: int = 0


@dataclass
class ScrapeResult:
    site: str
    category: str | None = None
    products_found: int = 0
    products_written: int = 0
    failed: bool = False
    error: str | None = None
