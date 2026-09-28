# Contributing to PCBuildSage

Thank you for your interest in contributing to PCBuildSage! This guide walks you through the project architecture, how to add a retailer or a whole country, contribute to the component registry, and submit code changes.

New here? Set up the project with the [README quick start](README.md#quick-start-local) first. Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md), and security issues go through [SECURITY.md](SECURITY.md), not public issues.

---

## 1. Project Architecture

PCBuildSage consists of:
- **TypeScript Core** (`src/lib`): Contains the compatibility rules engine, chat engine, grounding search, and configuration management.
- **Web Frontend** (`src/app` / `src/components`): Next.js single-page application.
- **CLI Frontend** (`src/cli`): Node.js interactive terminal client.
- **Python Scraper Engine** (`scraper`): Independent Python process that crawls retailer catalog pages and writes to a local SQLite database.

---

## 2. Add a Retailer or a Country

Scraping profiles live under `data/profiles/` (e.g., `data/profiles/india.json`). A profile is one country: its currency plus the retailers to scrape, each with target URLs and the CSS selectors that pick out product details. India is the only country so far, so a new country is one of the most valuable contributions you can make.

**Adding a country, end to end:**
1. Copy `data/profiles/us-example.json` (a template) to `data/profiles/<your-country>.json`, and set `profile_name`, `country_code` (ISO 3166, e.g. `DE`) and `default_currency` (ISO 4217, e.g. `EUR`).
2. Add a site block for each retailer: its category listing URLs (with `{page}` for pagination) and selectors. Start with two or three well-known retailers.
3. Test each site with `test-profile` (below) until the title, price and URL selectors hit 100%.
4. Run `npm run validate:data`, then open a pull request using the "New Retailer / Country Profile" category.
5. Once merged, anyone can scrape your country locally, and the app lists it as a market once it has in-stock products. The hosted demo currently refreshes India only; adding more countries to it is planned.

### Profile Structure
```json
{
  "$schema": "../schemas/profile.schema.json",
  "schema_version": 1,
  "profile_name": "India",
  "country_code": "IN",
  "default_currency": "INR",
  "sites": [
    {
      "site_name": "RetailerName",
      "base_url": "https://retailer.example.com",
      "scraping_type": "category",
      "browser_config": {
        "headless": true,
        "js_rendering": true,
        "timeout_ms": 30000
      },
      "selectors": {
        "product_container": "div.product-card",
        "title": "h3.product-title",
        "price": "span.price",
        "url": "a.product-link",
        "image": "img.product-image",
        "out_of_stock": "span.out-of-stock"
      },
      "categories": {
        "cpu": {
          "path": "/cpus?page={page}",
          "max_pages": 5
        }
      }
    }
  ]
}
```

### Testing a Profile
Before submitting a pull request with a new or updated profile, run selector validation checks locally:
```bash
# Via Node CLI
node bin/pcbuildsage.js test-profile data/profiles/india.json --site RetailerName

# Via Python directly
python3 -m scraper --test-profile data/profiles/india.json --site RetailerName
```
Ensure all mandatory selector hit rates (title, price, url) are at 100%.

---

## 3. Contributing to the Registry

The component specification registry is located under `data/registry/` as static JSON files (e.g., `cpus.json`, `gpus.json`). It is the source of truth for deterministic hardware compatibility checks.

Every entry needs `sources`: the URLs its specs come from, ideally the manufacturer's product or spec page. Please don't add specs from memory or from a model's answer without checking them against a source.

To update component specs:
1. Add or edit the entry by hand, or use the AI research drafts: specs the chat's research subagent found are exported with
   ```bash
   npm run export-research
   ```
   which writes draft entries to `data/registry/pending/` (created on first run).
2. Check each draft against its sources, then move it into the canonical registry file.
3. Verify that the JSON schemas remain valid:
   ```bash
   npm run validate:data
   ```

---

## 4. Code Style & Testing

### Node.js / TypeScript
- Format and lint code: `npm run lint`
- Verify types: `npm run typecheck`
- Run unit tests: `npm test` (Runs Vitest, including Tier 1 rules engine tests)

### Python Scraper
- Format and lint: `ruff check scraper`
- Run unit tests: `pytest scraper/tests`

---

## 5. Adding UI Themes

Themes style both the web app and the CLI. They live under `data/themes/` as JSON files validated against `data/schemas/theme.schema.json` (which documents every field and enforces WCAG AA contrast ratios).

To add a theme:

1. Copy an existing theme file (e.g. `data/themes/sage-dark.json`) and edit the colors.
2. Set `tokens` (hex `#RRGGBB` CSS variables for the web UI) and `ansi` (0–255 terminal color codes for the CLI).
3. Validate:
   ```bash
   npm run validate:data
   ```
   Fix any contrast failures the script reports.


