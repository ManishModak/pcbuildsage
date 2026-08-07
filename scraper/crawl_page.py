import sys
import asyncio
from pathlib import Path
from bs4 import BeautifulSoup

# Ensure scraper package is importable if run directly as a script
src_dir = Path(__file__).resolve().parent.parent
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

from scraper.crawler import Crawl4AIFetcher  # noqa: E402
from scraper.models import SiteConfig, BrowserConfig  # noqa: E402

async def main():
    if len(sys.argv) < 2:
        print("Usage: python crawl_page.py <url>")
        sys.exit(1)
    
    url = sys.argv[1]
    
    # Construct a dummy SiteConfig to satisfy the fetch signature
    site = SiteConfig(
        site_name="crawl_page",
        base_url=url,
        scraping_type="category",
        browser_config=BrowserConfig(headless=True, js_rendering=True),
        categories={},
        selectors={},
        country_code="US",
        currency="USD"
    )
    
    try:
        async with Crawl4AIFetcher() as fetcher:
            html = await fetcher.fetch(url, site)
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
