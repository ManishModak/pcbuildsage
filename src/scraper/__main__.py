from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import replace

from .config import ProfileError, REPO_ROOT, filter_sites, load_profile, resolve_categories
from .crawler import CrawlError, ScraperCrawler, category_page_url
from .db import ProductStore, utc_now_iso
from .extractor import selector_hit_rates
from .llm_client import LLMClient, resolve_llm_config
from .models import CategoryConfig, RawProduct, ScrapedProduct, SiteConfig
from .normalizer import RegistryMatcher, normalize_title, parse_price_minor, product_id
from .output import EventEmitter, configure_logging


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m scraper",
        description="PCBuildSage Python scraper engine.",
    )
    parser.add_argument("--profile", help="Profile name or JSON path, for example: india")
    parser.add_argument("--categories", help="Comma-separated category list, for example: gpu,cpu")
    parser.add_argument("--sites", help="Comma-separated site list")
    parser.add_argument("--site", help="Single site filter, mainly for --test-profile")
    parser.add_argument("--quick", action="store_true", help="Use quick crawl depth")
    parser.add_argument("--max-pages", type=int, help="Override pages per category")
    parser.add_argument("--skip-fresh", type=int, metavar="HOURS", help="Skip recently scraped rows")
    parser.add_argument("--no-llm-fallback", action="store_true", help="Disable LLM extraction fallback")
    parser.add_argument("--max-llm-calls", type=int, default=25, help="LLM extraction fallback call budget")
    parser.add_argument("--concurrency", type=int, default=2, help="Concurrent sites")
    parser.add_argument("--delay-ms", type=int, default=1000, help="Delay between requests")
    parser.add_argument("--headed", action="store_true", help="Run browser visibly")
    parser.add_argument("--db", default="data/products.db", help="SQLite database path")
    parser.add_argument("--json-stdout", action="store_true", help="Emit NDJSON progress events on stdout")
    parser.add_argument("--test-profile", help="Validate selectors without DB writes")
    parser.add_argument("--llm-provider", help="Override scraper LLM provider")
    parser.add_argument("--llm-model", help="Override scraper LLM model")
    parser.add_argument("--list-models", action="store_true", help="List models for the selected provider")
    return parser


def split_csv(value: str | None) -> list[str] | None:
    if not value:
        return None
    return [part.strip() for part in value.split(",") if part.strip()]


def page_limit(category: CategoryConfig, args: argparse.Namespace) -> int:
    if args.max_pages is not None:
        return max(1, args.max_pages)
    if args.quick:
        return min(2, category.max_pages)
    return category.max_pages


def estimate_seconds(work: list[tuple[SiteConfig, CategoryConfig, int]], delay_ms: int) -> int:
    pages = sum(limit for _, _, limit in work)
    return max(1, int(pages * (2.5 + delay_ms / 1000)))


def format_duration(seconds: int) -> str:
    minutes = max(1, round(seconds / 60))
    return f"~{minutes} min" if minutes >= 1 else f"~{seconds} sec"


def build_work(profile_arg: str, args: argparse.Namespace) -> tuple[list[tuple[SiteConfig, CategoryConfig, int]], object]:
    profile = load_profile(profile_arg)
    site_names = split_csv(args.sites)
    if args.site:
        site_names = [args.site]
    category_names = split_csv(args.categories)
    work: list[tuple[SiteConfig, CategoryConfig, int]] = []
    for site in filter_sites(profile, site_names):
        if args.headed:
            site = replace(site, browser_config=replace(site.browser_config, headless=False))
        for category in resolve_categories(site, category_names):
            work.append((site, category, page_limit(category, args)))
    return work, profile


def make_product(raw: RawProduct, site: SiteConfig, category: str, matcher: RegistryMatcher, scraped_at: str) -> ScrapedProduct | None:
    if not raw.title or not raw.url:
        return None
    normalized = normalize_title(raw.title)
    return ScrapedProduct(
        id=product_id(raw.url),
        name=raw.title,
        normalized_name=normalized,
        registry_key=matcher.match(normalized),
        price_minor=parse_price_minor(raw.price_text),
        currency=site.currency,
        country_code=site.country_code,
        retailer=site.site_name,
        url=raw.url,
        image_url=raw.image_url,
        in_stock=raw.in_stock,
        category=category,
        specs={},
        last_scraped=scraped_at,
    )


def search_terms_for_category(category: str, limit: int = 100) -> list[str]:
    candidates = [f"{category}s.json", f"{category}.json"]
    terms: list[str] = []
    for filename in candidates:
        path = REPO_ROOT / "data" / "registry" / filename
        if not path.exists():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        for key, entry in data.items():
            if key == "$schema" or not isinstance(entry, dict):
                continue
            aliases = entry.get("aliases")
            if isinstance(aliases, list):
                alias_terms = aliases
            elif isinstance(aliases, str):
                alias_terms = [aliases]
            else:
                alias_terms = []
            for term in [entry.get("model"), *alias_terms]:
                if isinstance(term, str) and term and term not in terms:
                    terms.append(term)
                if len(terms) >= limit:
                    return terms
    return terms or [category]


def write_products(db_path: str, products: list[ScrapedProduct], scraped_at: str, site: SiteConfig, category: CategoryConfig, run_started_at: str) -> int:
    with ProductStore(db_path) as store:
        written = store.upsert_products(products, scraped_at=scraped_at)
        store.sweep_stale_stock(site.site_name, category.name, run_started_at)
        return written


async def run_test_profile(args: argparse.Namespace, emitter: EventEmitter) -> int:
    work, _profile = build_work(args.test_profile, args)
    crawler = ScraperCrawler(delay_ms=args.delay_ms, llm_enabled=False)
    async with crawler.fetcher:
        for site, category, _limit in work:
            url = category_page_url(site, category, 1)
            emitter.logger.info("Testing %s/%s %s", site.site_name, category.name, url)
            html = await crawler.fetcher.fetch(url, site)
            rates = selector_hit_rates(html, site.selectors)
            parts = []
            for key in ("title", "price", "url", "image", "out_of_stock"):
                if key in rates:
                    hits, total = rates[key]
                    status = "OK" if total and hits == total else "WARN"
                    parts.append(f"{key}: {hits}/{total} {status}")
            line = f"{site.site_name} {category.name}: " + " ".join(parts)
            if args.json_stdout:
                emitter.logger.info(line)
            else:
                print(line)
    return 0


async def run_scrape(args: argparse.Namespace, emitter: EventEmitter) -> int:
    if not args.profile:
        raise ProfileError("--profile is required unless --test-profile or --list-models is used")
    work, _profile = build_work(args.profile, args)
    estimate = format_duration(estimate_seconds(work, args.delay_ms))
    emitter.logger.info("Estimated crawl time: %s (%d site/category jobs)", estimate, len(work))
    with ProductStore(args.db):
        pass

    llm_client = None
    if not args.no_llm_fallback:
        llm_client = LLMClient(resolve_llm_config(args.llm_provider, args.llm_model))
    crawler = ScraperCrawler(
        delay_ms=args.delay_ms,
        llm_client=llm_client,
        llm_enabled=not args.no_llm_fallback,
        max_llm_calls=args.max_llm_calls,
    )
    matcher = RegistryMatcher()
    semaphore = asyncio.Semaphore(max(1, args.concurrency))
    total_written = 0

    async def run_job(site: SiteConfig, category: CategoryConfig, limit: int) -> int:
        nonlocal crawler
        async with semaphore:
            run_started_at = utc_now_iso()
            emitter.emit("site_started", site=site.site_name, category=category.name)
            if args.skip_fresh:
                with ProductStore(args.db) as store:
                    if store.was_scraped_since(site.site_name, category.name, args.skip_fresh):
                        emitter.progress(site=site.site_name, category=category.name, percent=100, skipped=True)
                        return 0
            try:
                if site.scraping_type == "search":
                    terms = search_terms_for_category(category.name)
                    raw_products = await crawler.crawl_search(
                        site,
                        category,
                        terms,
                        limit,
                        on_page=lambda page, products, _html: emitter.progress(
                            site=site.site_name,
                            category=category.name,
                            page=page,
                            pages_total=limit,
                            products_seen=len(products),
                            percent=min(99, int(page / limit * 100)),
                        ),
                    )
                else:
                    raw_products = await crawler.crawl_category(
                        site,
                        category,
                        limit,
                        on_page=lambda page, products, _html: emitter.progress(
                            site=site.site_name,
                            category=category.name,
                            page=page,
                            pages_total=limit,
                            products_seen=len(products),
                            percent=min(99, int(page / limit * 100)),
                        ),
                    )
                scraped_at = utc_now_iso()
                products = [
                    product
                    for raw in raw_products
                    if (product := make_product(raw, site, category.name, matcher, scraped_at)) is not None
                ]
                written = await asyncio.to_thread(write_products, args.db, products, scraped_at, site, category, run_started_at)
                emitter.progress(site=site.site_name, category=category.name, percent=100, products_seen=len(products))
                return written
            except Exception as exc:
                emitter.emit("site_failed", site=site.site_name, category=category.name, error=str(exc))
                return 0

    async with crawler.fetcher:
        results = await asyncio.gather(*(run_job(site, category, limit) for site, category, limit in work))
    total_written = sum(results)
    emitter.emit("done", products_written=total_written)
    return 0


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    logger = configure_logging()
    emitter = EventEmitter(args.json_stdout, logger)
    try:
        if args.list_models:
            client = LLMClient(resolve_llm_config(args.llm_provider, args.llm_model))
            for model in client.list_models():
                print(model)
            return 0
        if args.test_profile:
            return asyncio.run(run_test_profile(args, emitter))
        if not args.profile:
            parser.print_help(sys.stderr)
            return 2
        return asyncio.run(run_scrape(args, emitter))
    except (ProfileError, CrawlError, RuntimeError, ValueError) as exc:
        emitter.emit("error", error=str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
