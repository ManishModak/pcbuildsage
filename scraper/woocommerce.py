"""Deterministic WooCommerce Store API extraction; no browser or LLM recovery."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from decimal import Decimal
from html import unescape
from typing import Callable
from urllib.parse import urlencode, urljoin, urlparse

from .crawler import BotProtectionError, CrawlError, CrawlProducts, HttpStatusError, ScraperCrawler, WAF_MARKERS
from .models import CategoryConfig, RawProduct, SiteConfig

logger = logging.getLogger(__name__)

PAGE_SIZE = 100


def woocommerce_category_url(site: SiteConfig, category: CategoryConfig, page: int, path: str | None = None) -> str:
    """Use category slugs and stable ID ordering, including sold-out products."""
    slug = path if path is not None else category.path
    query = urlencode({"category": slug, "per_page": PAGE_SIZE,
                       "page": page, "orderby": "id", "order": "asc"})
    return urljoin(site.base_url, "wp-json/wc/store/v1/products") + "?" + query


def raw_from_woocommerce_product(item: dict, site: SiteConfig) -> RawProduct:
    """Map the advertised current price, stock and canonical product permalink."""
    name, url = item.get("name"), item.get("permalink")
    prices = item.get("prices")
    if not isinstance(name, str) or not name.strip() or not isinstance(url, str):
        raise ValueError("missing product name or permalink")
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or parsed.netloc != urlparse(site.base_url).netloc or not parsed.path.strip("/"):
        raise ValueError("invalid product permalink")
    if not isinstance(prices, dict) or prices.get("currency_code") != site.currency:
        raise ValueError("missing prices or unexpected currency")
    unit, price = prices.get("currency_minor_unit"), prices.get("price")
    if type(unit) is not int or not 0 <= unit <= 6 or not isinstance(price, str) or not re.fullmatch(r"\d+", price):
        raise ValueError("invalid minor-unit price")
    if type(item.get("is_in_stock")) is not bool:
        raise ValueError("missing stock flag")
    images = item.get("images", [])
    if not isinstance(images, list):
        raise ValueError("invalid images")
    image = images[0].get("src") if images and isinstance(images[0], dict) else None
    return RawProduct(
        title=unescape(name).strip(), price_text=format(Decimal(price).scaleb(-unit), "f"),
        url=url, image_url=image, in_stock=item["is_in_stock"],
    )


async def _crawl_woocommerce_slug(
    crawler: ScraperCrawler,
    site: SiteConfig,
    category: CategoryConfig,
    slug: str,
    page_limit: int,
    seen_ids: set[int],
    seen_urls: set[str],
    products: CrawlProducts,
    on_page: Callable[[int, list[RawProduct], str], None] | None = None,
) -> None:
    """Crawl one WooCommerce category slug, deduplicating overlaps and skipping bad items."""
    for page in range(1, page_limit + 1):
        url = woocommerce_category_url(site, category, page, path=slug)
        try:
            body, headers = await crawler.fetcher.fetch_http_response(url, site)
            if any(marker in body.lower() for marker in WAF_MARKERS):
                crawler.blocked_sites.add(site.site_name)
                raise CrawlError(f"bot protection on {url}")
            items = json.loads(body)
            if not isinstance(items, list):
                raise ValueError("expected a product list")
            total, pages = int(headers["x-wp-total"]), int(headers["x-wp-totalpages"])
            if total < 0 or pages < 0 or (total > 0 and pages < 1):
                raise ValueError("invalid pagination totals")
            if total > 0 and page <= pages and not items:
                raise ValueError(f"page {page}: expected rows for total={total}, got empty list")
            raws: list[RawProduct] = []
            valid_on_page = 0
            skipped_malformed = 0
            for item in items:
                if not isinstance(item, dict) or type(item.get("id")) is not int or item["id"] <= 0:
                    skipped_malformed += 1
                    continue
                try:
                    raw = raw_from_woocommerce_product(item, site)
                except ValueError as item_err:
                    skipped_malformed += 1
                    logger.warning(
                        "%s/%s (%s) page %d skipped malformed item id=%s: %s",
                        site.site_name,
                        category.name,
                        slug,
                        page,
                        item.get("id"),
                        item_err,
                        extra={"component": "scraper"},
                    )
                    continue
                valid_on_page += 1
                if item["id"] in seen_ids or raw.url in seen_urls:
                    continue
                seen_ids.add(item["id"])
                seen_urls.add(raw.url)
                raws.append(raw)
            if items and valid_on_page == 0:
                raise ValueError(f"page {page}: all {skipped_malformed} item(s) were malformed")
            if page > 1 and valid_on_page > 0 and not raws:
                # Entire page repeated earlier items: stop rather than looping forever.
                raise ValueError(f"page {page} repeated earlier products")
        except (CrawlError, ValueError, KeyError, TypeError) as exc:
            if isinstance(exc, BotProtectionError) or (isinstance(exc, HttpStatusError) and exc.status == 403):
                crawler.blocked_sites.add(site.site_name)
            if page == 1 and not products:
                raise CrawlError(f"{site.site_name}/{category.name}: {exc}") from exc
            products.partial = True
            products.partial_error = str(exc)
            return
        products.extend(raws)
        if on_page:
            on_page(page, raws, body)
        if page >= pages or not items:
            return
        if page < page_limit and crawler.delay_ms > 0:
            await asyncio.sleep(crawler.delay_ms / 1000)
    products.partial = True
    products.partial_error = f"stopped at page limit {page_limit} before all advertised rows"


async def crawl_woocommerce_category(
    crawler: ScraperCrawler, site: SiteConfig, category: CategoryConfig, page_limit: int,
    on_page: Callable[[int, list[RawProduct], str], None] | None = None,
) -> CrawlProducts:
    """Crawl every configured slug for a WooCommerce category, deduplicating across pages/paths.

    Individual malformed rows are skipped and overlapping rows across pages or
    multi-path shelves are deduplicated instead of aborting the whole category.
    Hard fetch/parse failures on later pages or paths keep earlier rows as
    partial so the stale sweep is skipped. Cancellation propagates.
    """
    if site.site_name in crawler.blocked_sites:
        raise CrawlError(f"{site.site_name}: remaining categories stopped after bot protection or HTTP 403")
    products = CrawlProducts()
    seen_ids: set[int] = set()
    seen_urls: set[str] = set()
    slugs = category.all_paths
    for idx, slug in enumerate(slugs):
        if site.site_name in crawler.blocked_sites:
            products.partial = True
            products.partial_error = f"{site.site_name}: stopped after bot protection or HTTP 403"
            return products
        await _crawl_woocommerce_slug(
            crawler, site, category, slug, page_limit, seen_ids, seen_urls, products, on_page=on_page
        )
        if idx + 1 < len(slugs) and crawler.delay_ms > 0 and site.site_name not in crawler.blocked_sites:
            await asyncio.sleep(crawler.delay_ms / 1000)
    return products
