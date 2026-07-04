from __future__ import annotations

import argparse


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m scraper",
        description="PCBuildSage scraper entry point. Scraping implementation arrives in Plan 2.",
    )
    parser.add_argument("--profile", help="Profile name or JSON path, for example: india")
    parser.add_argument("--categories", help="Comma-separated category list, for example: gpu,cpu")
    parser.add_argument("--sites", help="Comma-separated site list")
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


def main() -> int:
    parser = build_parser()
    parser.parse_args()
    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
