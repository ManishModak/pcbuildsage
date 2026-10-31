"""Offline Store API fixtures exercise completeness and production sweep routing."""

import asyncio
import gzip
import http.client
import json
import urllib.error
from email.message import Message
from io import BytesIO
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlparse

import pytest

from scraper import __main__ as cli
from scraper.config import ProfileError, load_profile
from scraper.crawler import CrawlError, Crawl4AIFetcher, HttpStatusError, ScraperCrawler
from scraper.db import ProductStore
from scraper.woocommerce import crawl_woocommerce_category, raw_from_woocommerce_product


def site():
    return next(s for s in load_profile("india").sites if s.site_name == "PrimeABGB")


def item(number=1):
    return {"id": number, "name": "Example &amp; CPU", "permalink": f"https://www.primeabgb.com/product/{number}/",
            "prices": {"currency_code": "INR", "currency_minor_unit": 2,
                       "price": "123450", "regular_price": "200000", "sale_price": "123450"},
            "is_in_stock": True, "images": [{"src": "https://www.primeabgb.com/image.jpg"}]}


def response(items, total=101, pages=2):
    return json.dumps(items), {"x-wp-total": str(total), "x-wp-totalpages": str(pages)}


def crawler(responses):
    fetcher = AsyncMock()
    fetcher.fetch_http_response.side_effect = responses
    return ScraperCrawler(fetcher=fetcher, delay_ms=0, llm_client=AsyncMock())


def crawl(responses, limit=100):
    c = crawler(responses)
    s = site()
    result = asyncio.run(crawl_woocommerce_category(c, s, s.categories["cpu"], limit))
    assert c.llm_calls == 0
    c.fetcher.fetch_browser.assert_not_called()
    return result


def test_all_advertised_rows_complete_without_empty_probe():
    rows = [item(i) for i in range(1, 101)]
    found = crawl([response(rows), response([item(101)])])
    assert len(found) == 101 and not found.partial


@pytest.mark.parametrize("later", [
    CrawlError("timeout"), HttpStatusError("https://example.test", 404),
    HttpStatusError("https://example.test", 403),
    ("<title>Just a moment...</title>", {}), ("{}", {}),
    response([]), response([item(1)]), response([item(101)], 102),
    (json.dumps([item(101)]), {}),
])
def test_later_failure_or_inconsistent_listing_preserves_partial(later):
    found = crawl([response([item(i) for i in range(1, 101)]), later])
    assert len(found) == 100 and found.partial and found.partial_error


def test_cap_is_partial_even_with_valid_first_page():
    found = crawl([response([item(i) for i in range(1, 101)])], limit=1)
    assert len(found) == 100 and found.partial


@pytest.mark.parametrize("first", [CrawlError("blocked"), ("not JSON", {}), response([item()], 100, 1)])
def test_first_failure_is_not_a_complete_empty_listing(first):
    with pytest.raises(CrawlError):
        crawl([first])


def test_empty_category_and_duplicate_ids_within_page():
    assert not crawl([response([], 0, 0)]).partial
    with pytest.raises(CrawlError, match="repeated"):
        crawl([response([item(), item()], 2, 1)])


def test_current_price_stock_image_and_variable_product_fields():
    s = site()
    product = item()
    product.update(type="variable", is_in_stock=False)
    product["prices"]["price_range"] = {"min_amount": "123450", "max_amount": "250000"}
    raw = raw_from_woocommerce_product(product, s)
    assert (raw.title, raw.price_text, raw.in_stock) == ("Example & CPU", "1234.50", False)
    assert raw.url == product["permalink"] and raw.image_url == product["images"][0]["src"]
    product["prices"].update(currency_minor_unit=0, price="1234")
    assert raw_from_woocommerce_product(product, s).price_text == "1234"


@pytest.mark.parametrize("edit", [
    {"name": ""}, {"is_in_stock": "false"}, {"permalink": "javascript:bad"},
    {"prices": {"currency_code": "USD", "price": "123", "currency_minor_unit": 2}},
    {"prices": {"currency_code": "INR", "price": "NaN", "currency_minor_unit": 2}},
])
def test_malformed_product_fails_instead_of_inventing_fields(edit):
    bad = item()
    bad.update(edit)
    with pytest.raises(CrawlError):
        crawl([response([bad], 1, 1)])


def test_slug_validation_and_profile_needs_no_browser(tmp_path):
    s = site()
    assert s.scraping_type == "woocommerce_json" and s.selectors == {}
    profile = json.loads(open("data/profiles/india.json").read())
    bad = next(s for s in profile["sites"] if s["site_name"] == "PrimeABGB")
    bad["categories"]["cpu"]["path"] = "cpu&category=other"
    target = tmp_path / "bad.json"
    target.write_text(json.dumps(profile))
    with pytest.raises(ProfileError, match="category slug"):
        load_profile(target)


@pytest.mark.parametrize("partial", [False, True])
def test_production_cli_records_scope_and_sweeps_only_complete(monkeypatch, tmp_path, partial):
    responses = ([response([item(i) for i in range(1, 101)]), CrawlError("page two timeout")]
                 if partial else [response([item()], 1, 1)])
    mock_fetch = AsyncMock(side_effect=responses)
    monkeypatch.setattr(Crawl4AIFetcher, "fetch_http_response", mock_fetch)
    monkeypatch.setattr(ScraperCrawler, "_run_llm_fallback", AsyncMock(side_effect=AssertionError("LLM used")))
    db = tmp_path / "catalog.db"
    args = cli.build_parser().parse_args([
        "--profile", "india", "--site", "PrimeABGB", "--categories", "cpu",
        "--db", str(db), "--delay-ms", "0", "--no-llm-fallback",
    ])
    old = cli.make_product(raw_from_woocommerce_product(item(999), site()), site(), "cpu", cli.RegistryMatcher(), "2020-01-01T00:00:00Z")
    with ProductStore(str(db)) as store:
        store.upsert_products([old])
    asyncio.run(cli.run_scrape(args, cli.EventEmitter(False)))
    with ProductStore(str(db)) as store:
        status = store.conn.execute("SELECT status FROM scrape_jobs").fetchone()[0]
        stock = store.conn.execute("SELECT in_stock FROM products WHERE url = ?", (old.url,)).fetchone()[0]
        saved = store.conn.execute("SELECT name, price, category FROM products WHERE url = ?", (item()["permalink"],)).fetchone()
    assert status == ("partial" if partial else "complete")
    assert bool(stock) == partial
    assert tuple(saved) == ("Example & CPU", 1234.5, "cpu")


def test_cancellation_propagates():
    with pytest.raises(asyncio.CancelledError):
        crawl([asyncio.CancelledError()])


def test_http_preserves_total_headers_and_does_not_retry_403(monkeypatch):
    headers = Message()
    headers["X-WP-Total"] = "166"
    headers["X-WP-TotalPages"] = "2"

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def info(self):
            return headers

        def geturl(self):
            return "https://www.primeabgb.com/wp-json/wc/store/v1/products"

        def read(self):
            return b"[]"

    monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: Response())
    body, received = asyncio.run(Crawl4AIFetcher().fetch_http_response(site().base_url, site()))
    assert body == "[]" and received == {"x-wp-total": "166", "x-wp-totalpages": "2"}
    calls = []

    def denied(*args, **kwargs):
        calls.append(1)
        raise urllib.error.HTTPError(site().base_url, 403, "Forbidden", headers, None)

    monkeypatch.setattr("urllib.request.urlopen", denied)
    with pytest.raises(HttpStatusError):
        asyncio.run(Crawl4AIFetcher().fetch_http_response(site().base_url, site()))
    assert len(calls) == 1


def test_profile_check_returns_failure_for_partial_or_blocked(monkeypatch):
    for response in [HttpStatusError(site().base_url, 403), response_page_limit()]:
        mock_fetch = AsyncMock(side_effect=[response])
        monkeypatch.setattr(Crawl4AIFetcher, "fetch_http_response", mock_fetch)
        args = cli.build_parser().parse_args([
            "--test-profile", "india", "--site", "PrimeABGB", "--categories", "cpu", "--max-pages", "1",
        ])
        assert asyncio.run(cli.run_test_profile(args, cli.EventEmitter(False))) == 1


def response_page_limit():
    return response([item(i) for i in range(1, 101)])


@pytest.mark.parametrize("block", [HttpStatusError("https://example.test", 403),
                                    ("<title>Just a moment...</title>", {})])
@pytest.mark.parametrize("later_page", [False, True])
def test_block_stops_all_remaining_categories_in_production(monkeypatch, tmp_path, block, later_page):
    responses = [response_page_limit(), block] if later_page else [block]
    fetch = AsyncMock(side_effect=responses)
    monkeypatch.setattr(Crawl4AIFetcher, "fetch_http_response", fetch)
    db = tmp_path / "catalog.db"
    args = cli.build_parser().parse_args([
        "--profile", "india", "--site", "PrimeABGB", "--db", str(db),
        "--delay-ms", "0", "--no-llm-fallback",
    ])
    assert asyncio.run(cli.run_scrape(args, cli.EventEmitter(False))) == (0 if later_page else 1)
    assert fetch.await_count == (2 if later_page else 1)
    with ProductStore(str(db)) as store:
        statuses = dict(store.conn.execute("SELECT category, status FROM scrape_jobs").fetchall())
        assert len(statuses) == 8
        assert statuses.pop("cpu") == ("partial" if later_page else "failed")
        assert set(statuses.values()) == {"failed"}
        assert store.conn.execute("SELECT count(*) FROM products").fetchone()[0] == (100 if later_page else 0)


def test_profile_check_stops_all_categories_after_block(monkeypatch):
    fetch = AsyncMock(side_effect=HttpStatusError(site().base_url, 403))
    monkeypatch.setattr(Crawl4AIFetcher, "fetch_http_response", fetch)
    args = cli.build_parser().parse_args(["--test-profile", "india", "--site", "PrimeABGB"])
    assert asyncio.run(cli.run_test_profile(args, cli.EventEmitter(False))) == 1
    assert fetch.await_count == 1


def test_production_requests_each_intended_category_and_advances_page(monkeypatch, tmp_path):
    expected = {"cpu": "cpu-processor", "gpu": "graphic-cards-gpu", "motherboard": "motherboards",
                "ram": "ram-memory", "storage": "ssd", "psu": "power-supplies-smps",
                "case": "pc-cases-cabinet", "cooler": "cpu-cooler"}
    responses = [response_page_limit(), response([item(101)])]
    responses += [response([item(i)], 1, 1) for i in range(102, 109)]
    fetch = AsyncMock(side_effect=responses)
    monkeypatch.setattr(Crawl4AIFetcher, "fetch_http_response", fetch)
    args = cli.build_parser().parse_args([
        "--profile", "india", "--site", "PrimeABGB", "--db", str(tmp_path / "catalog.db"),
        "--delay-ms", "0", "--no-llm-fallback",
    ])
    assert asyncio.run(cli.run_scrape(args, cli.EventEmitter(False))) == 0
    expected_calls = [(expected["cpu"], 1), (expected["cpu"], 2)] + [(slug, 1) for name, slug in expected.items() if name != "cpu"]
    assert len(fetch.await_args_list) == len(expected_calls)
    for call, (slug, page) in zip(fetch.await_args_list, expected_calls):
        url = urlparse(call.args[0])
        assert url.scheme == "https" and url.netloc == "www.primeabgb.com"
        assert url.path == "/wp-json/wc/store/v1/products"
        assert parse_qs(url.query) == {"category": [slug], "per_page": ["100"], "page": [str(page)],
                                      "orderby": ["id"], "order": ["asc"]}


class HttpResponse:
    """urllib response fixture keeps transport and production routing real."""

    def __init__(self, body, headers):
        self.body, self.headers = body, headers

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def info(self):
        return self.headers

    def geturl(self):
        return "https://www.primeabgb.com/wp-json/wc/store/v1/products"

    def read(self):
        return self.body


class TruncatedErrorBody(BytesIO):
    """An HTTP error body can fail after the definitive status was received."""

    def __init__(self, partial=b"truncated"):
        super().__init__()
        self.partial = partial

    def read(self, *args):
        raise http.client.IncompleteRead(self.partial)


@pytest.mark.parametrize("kind", ["header503", "body503", "gzip503", "header200", "truncated403", "truncated503"])
@pytest.mark.parametrize("later_page", [False, True])
def test_transport_challenge_stops_retries_and_remaining_categories(monkeypatch, tmp_path, kind, later_page):
    calls = []

    def fetch(req, **kwargs):
        calls.append(req.full_url)
        headers = Message()
        if later_page and len(calls) == 1:
            body, totals = response_page_limit()
            for key, value in totals.items():
                headers[key] = value
            return HttpResponse(body.encode(), headers)
        body = b"<title>Just a moment...</title>"
        if kind.startswith("header"):
            headers["cf-mitigated"] = "challenge"
            body = b"challenge indicated only by header"
        if kind == "gzip503":
            headers["Content-Encoding"] = "gzip"
            body = gzip.compress(body)
        if kind == "header200":
            return HttpResponse(body, headers)
        if kind == "truncated403":
            raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", headers, TruncatedErrorBody())
        if kind == "truncated503":
            raise urllib.error.HTTPError(req.full_url, 503, "Unavailable", headers, TruncatedErrorBody(body))
        raise urllib.error.HTTPError(req.full_url, 503, "Unavailable", headers, BytesIO(body))

    monkeypatch.setattr("urllib.request.urlopen", fetch)
    db = tmp_path / "catalog.db"
    args = cli.build_parser().parse_args([
        "--profile", "india", "--site", "PrimeABGB", "--db", str(db),
        "--delay-ms", "0", "--no-llm-fallback",
    ])
    assert asyncio.run(cli.run_scrape(args, cli.EventEmitter(False))) == (0 if later_page else 1)
    assert len(calls) == (2 if later_page else 1)
    with ProductStore(str(db)) as store:
        statuses = dict(store.conn.execute("SELECT category, status FROM scrape_jobs").fetchall())
        assert len(statuses) == 8
        assert statuses.pop("cpu") == ("partial" if later_page else "failed")
        assert set(statuses.values()) == {"failed"}
        assert store.conn.execute("SELECT count(*) FROM products").fetchone()[0] == (100 if later_page else 0)


@pytest.mark.parametrize("truncated", [False, True])
def test_ordinary_transient_503_still_retries(monkeypatch, truncated):
    calls = []

    def fetch(req, **kwargs):
        calls.append(req.full_url)
        headers = Message()
        if len(calls) == 1:
            body = TruncatedErrorBody() if truncated else BytesIO(b"Temporary outage")
            raise urllib.error.HTTPError(req.full_url, 503, "Unavailable", headers, body)
        body, totals = response([item()], 1, 1)
        for key, value in totals.items():
            headers[key] = value
        return HttpResponse(body.encode(), headers)

    async def no_sleep(_seconds):
        pass

    monkeypatch.setattr("urllib.request.urlopen", fetch)
    monkeypatch.setattr("scraper.crawler.asyncio.sleep", no_sleep)
    c = ScraperCrawler(delay_ms=0)
    s = site()
    found = asyncio.run(crawl_woocommerce_category(c, s, s.categories["cpu"], 100))
    assert len(calls) == 2 and len(found) == 1 and not found.partial
    assert not c.blocked_sites
