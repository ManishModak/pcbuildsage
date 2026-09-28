import sys
import asyncio
from pathlib import Path
from urllib.parse import urlparse
from bs4 import BeautifulSoup

# Ensure scraper package is importable if run directly as a script
src_dir = Path(__file__).resolve().parent.parent
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

from scraper.crawler import Crawl4AIFetcher  # noqa: E402
from scraper.models import SiteConfig, BrowserConfig  # noqa: E402

# Node's crawlPage deadline is 30s: HTTP + browser budgets must fit inside
# it with room for startup overhead. Single attempt, no retries.
CRAWL_PAGE_TIMEOUT_MS = 20000
CRAWL_PAGE_OVERALL_TIMEOUT_S = 25.0


def _assert_http_url(url: str) -> None:
    try:
        scheme = urlparse(url).scheme.lower()
    except Exception as exc:
        raise ValueError(f"Invalid URL {url!r}: {exc}") from exc
    if scheme not in ("http", "https"):
        raise ValueError(f"Refusing to crawl non-http(s) URL: {url!r}")


async def _fetch_with_budget(fetcher: Crawl4AIFetcher, url: str, site: SiteConfig) -> str:
    # Prefer fast HTTP; fall back to the browser once. Each engine gets a
    # single attempt so the total stays inside the Node 30s deadline.
    try:
        return await fetcher.fetch_http(url, site, retries=1)
    except Exception:
        return await fetcher.fetch_browser(url, site, retries=1)


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
        async with Crawl4AIFetcher() as fetcher:
            html = await asyncio.wait_for(
                _fetch_with_budget(fetcher, url, site),
                timeout=CRAWL_PAGE_OVERALL_TIMEOUT_S,
            )
    except asyncio.TimeoutError:
        print("Error crawling page: crawl timed out", file=sys.stderr)
        sys.exit(1)
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
