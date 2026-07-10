import sys
import asyncio

async def main():
    if len(sys.argv) < 2:
        print("Usage: python crawl_page.py <url>")
        sys.exit(1)
    
    url = sys.argv[1]
    
    # Try Crawl4AI first
    try:
        from crawl4ai import AsyncWebCrawler, CacheMode, CrawlerRunConfig
        
        config = CrawlerRunConfig(cache_mode=CacheMode.BYPASS)
        async with AsyncWebCrawler() as crawler:
            result = await crawler.arun(url=url, config=config)
            if result.success and result.markdown:
                print(result.markdown)
                return
    except Exception as e:
        # Fall back to BeautifulSoup
        pass

    # Fallback: urllib + BeautifulSoup
    try:
        import urllib.request
        from bs4 import BeautifulSoup
        
        # Add a realistic User-Agent to avoid simple blocking
        req = urllib.request.Request(
            url, 
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            html = response.read().decode('utf-8', errors='ignore')
            
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
        print(f"Error crawling page: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
