# Contributing to PCBuildSage

Thank you for your interest in contributing to PCBuildSage! This guide walks you through the project architecture, how to write or update scraping profiles, contribute to the component registry, and submit code changes.

---

## 1. Project Architecture

PCBuildSage consists of:
- **TypeScript Core** (`src/lib`): Contains the compatibility rules engine, chat engine, grounding search, and configuration management.
- **Web Frontend** (`src/app` / `src/components`): Next.js single-page application.
- **CLI Frontend** (`src/cli`): Node.js interactive terminal client.
- **Python Scraper Engine** (`scraper`): Independent Python process that crawls retailer catalog pages and writes to a local SQLite database.

---

## 2. Scraping Profiles Walkthrough

Scraping profiles live under `data/profiles/` (e.g., `data/profiles/india.json`). They define the sites, target URLs, and CSS selectors for extracting product information.

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
pcbuildsage test-profile data/profiles/india.json --site RetailerName

# Via Python directly
python3 -m scraper --test-profile data/profiles/india.json --site RetailerName
```
Ensure all mandatory selector hit rates (title, price, url) are at 100%.

---

## 3. Contributing to the Registry

The component specification registry is located under `data/registry/` as static JSON files (e.g., `cpus.json`, `gpus.json`). It is the source of truth for deterministic hardware compatibility checks.

To update component specs:
1. Use the LLM research subagent or `export-research` CLI command to compile specs:
   ```bash
   pcbuildsage export-research
   ```
2. Move validated specs from `data/registry/pending/` to the canonical registry file.
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

1. Copy an existing theme file (e.g. `data/themes/nord-dark.json`) and edit the colors.
2. Set `tokens` (hex `#RRGGBB` CSS variables for the web UI) and `ansi` (0–255 terminal color codes for the CLI).
3. Validate:
   ```bash
   npm run validate:data
   ```
   Fix any contrast failures the script reports.


