import time

# Budget clock starts before the heavy imports below so they count too.
_PROCESS_START = time.monotonic()

import os  # noqa: E402
import sys  # noqa: E402
import asyncio  # noqa: E402
import ipaddress  # noqa: E402
import socket  # noqa: E402
from pathlib import Path  # noqa: E402
from urllib.parse import urlparse  # noqa: E402
from bs4 import BeautifulSoup  # noqa: E402

# Ensure scraper package is importable if run directly as a script
src_dir = Path(__file__).resolve().parent.parent
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

from scraper.crawler import Crawl4AIFetcher  # noqa: E402
from scraper.models import SiteConfig, BrowserConfig  # noqa: E402

# Node's crawlPage deadline is 30s. The whole run (imports, browser start,
# fetch, teardown) gets 25s from process start, then at most a 2s grace for
# cancellation cleanup before a hard exit: 27s, inside Node's deadline.
CRAWL_PAGE_TIMEOUT_MS = 20000
CRAWL_PAGE_OVERALL_TIMEOUT_S = 25.0
CRAWL_PAGE_CANCEL_GRACE_S = 2.0


class CrawlPageTimeout(Exception):
    """The crawl, including browser teardown, did not finish within budget."""


def _assert_http_url(url: str) -> None:
    try:
        parsed = urlparse(url)
        scheme = parsed.scheme.lower()
    except Exception as exc:
        raise ValueError(f"Invalid URL {url!r}: {exc}") from exc
    if scheme not in ("http", "https"):
        raise ValueError(f"Refusing to crawl non-http(s) URL: {url!r}")
    hostname = parsed.hostname
    if not hostname:
        raise ValueError(f"URL missing hostname: {url!r}")
    host_clean = hostname.strip("[]").lower()
    if host_clean in ("localhost", "127.0.0.1", "::1", "0.0.0.0"):
        raise ValueError(f"Crawl blocked: private or loopback address {hostname!r}")
    try:
        addrinfo = socket.getaddrinfo(host_clean, None)
        for res in addrinfo:
            ip_str = res[4][0]
            ip = ipaddress.ip_address(ip_str)
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
                raise ValueError(f"Crawl blocked: {hostname!r} resolves to private or loopback address {ip_str}")
    except socket.gaierror as e:
        raise ValueError(f"Crawl blocked: could not resolve {hostname!r}: {e}") from e


async def _fetch_with_budget(fetcher: Crawl4AIFetcher, url: str, site: SiteConfig) -> str:
    # Prefer fast HTTP; fall back to the browser once. Each engine gets a
    # single attempt so the total stays inside the Node 30s deadline.
    try:
        return await fetcher.fetch_http(url, site, retries=1)
    except Exception:
        return await fetcher.fetch_browser(url, site, retries=1)


async def _crawl_within(url: str, site: SiteConfig, deadline: float, fetcher_factory=Crawl4AIFetcher) -> str:
    """Fetch `url` with browser start and teardown finished before `deadline`.

    `deadline` is a time.monotonic() value. On overrun the crawl is cancelled,
    given CRAWL_PAGE_CANCEL_GRACE_S to close browsers, and CrawlPageTimeout is
    raised even if that cleanup is still stuck (the caller then hard-exits).
    """

    async def _run() -> str:
        async with fetcher_factory() as fetcher:
            return await _fetch_with_budget(fetcher, url, site)

    task = asyncio.ensure_future(_run())
    done, _ = await asyncio.wait({task}, timeout=max(0.0, deadline - time.monotonic()))
    if task in done:
        return task.result()
    task.cancel()
    await asyncio.wait({task}, timeout=CRAWL_PAGE_CANCEL_GRACE_S)
    raise CrawlPageTimeout("crawl timed out")


async def main():
    if len(sys.argv) < 2:
        print("Usage: python crawl_page.py <url>")
        sys.exit(1)

    url = sys.argv[1]
    try:
        _assert_http_url(url)
    except ValueError as e:
        print(f"Error crawling page: {e}", file=sys.stderr)
        sys.exit(2)

    # Construct a dummy SiteConfig to satisfy the fetch signature
    site = SiteConfig(
        site_name="crawl_page",
        base_url=url,
        scraping_type="category",
        browser_config=BrowserConfig(headless=True, js_rendering=True, timeout_ms=CRAWL_PAGE_TIMEOUT_MS),
        categories={},
        selectors={},
        country_code="US",
        currency="USD"
    )

    try:
        html = await _crawl_within(url, site, _PROCESS_START + CRAWL_PAGE_OVERALL_TIMEOUT_S)
    except CrawlPageTimeout:
        print("Error crawling page: crawl timed out", file=sys.stderr)
        sys.stderr.flush()
        # asyncio.run would wait on a teardown that ignored cancellation.
        os._exit(1)
    except Exception as e:
        print(f"Error crawling page: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        soup = BeautifulSoup(html, 'html.parser')

        # Remove script, style, and metadata elements
        for tag in soup(["script", "style", "meta", "noscript", "header", "footer"]):
            tag.extract()

        # Get text
        text = soup.get_text(separator='\n')

        # Clean up whitespace
        lines = (line.strip() for line in text.splitlines())
        chunks = (phrase for line in lines for phrase in line.split("  "))
        clean_text = '\n'.join(chunk for chunk in chunks if chunk)

        print(clean_text)
    except Exception as e:
        print(f"Error parsing page content: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
