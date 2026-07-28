# Contributing to PCBuildSage

Thank you for your interest in contributing to PCBuildSage! This guide walks you through the project architecture, how to write or update scraping profiles, contribute to the component registry, and submit code changes.

---

## 1. Project Architecture

PCBuildSage consists of:
- **TypeScript Core** (`src/lib`): Contains the compatibility rules engine, chat engine, grounding search, and configuration management.
- **Web Frontend** (`src/app` / `src/components`): Next.js single-page application.
- **CLI Frontend** (`src/cli`): Node.js interactive terminal client.
- **Python Scraper Engine** (`src/scraper`): Independent Python process that crawls retailer catalog pages and writes to a local SQLite database.

---

## 2. Scraping Profiles Walkthrough

Scraping profiles live under `data/profiles/` (e.g., `data/profiles/india.json`). They define the sites, target URLs, and CSS selectors for extracting product information.

### Profile Structure
```json
{
  "$schema": "../schemas/profile.schema.json",
  "countryCode": "IN",
  "currency": "INR",
  "flag": "🇮🇳",
  "profileName": "India",
  "sites": [
    {
      "site_name": "RetailerName",
      "base_url": "https://retailer.example.com",
      "scraping_type": "category",
      "browser_config": {
        "headless": true
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
PYTHONPATH=src python3 -m scraper --test-profile data/profiles/india.json --site RetailerName
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
- Format and lint: `ruff check src/scraper`
- Run unit tests: `PYTHONPATH=src pytest src/scraper/tests`

---

## 5. Adding UI Themes

You can skin both the Web and CLI interfaces by adding themes.

### 🎨 UI Themes

Themes style both the Next.js web application and the interactive terminal CLI. Themes are defined in JSON files located under `data/themes/` and validated against `data/schemas/theme.schema.json`.

#### Schema Fields
- **`$schema`**: Points to `../schemas/theme.schema.json`.
- **`schema_version`**: Must be `1`.
- **`theme_name`**: Unique name of your theme.
- **`mode`**: Either `"dark"` or `"light"`.
- **`tokens`**: CSS variables for the web app UI (must be in `#RRGGBB` format):
  - `--bg`: Main page background.
  - `--surface`: Containers and background elements.
  - `--surface-raised`: Tooltips, modals, elevated surfaces.
  - `--border`: Standard divider border lines.
  - `--text`: Main readable text.
  - `--text-secondary`: Secondary captions/text.
  - `--text-muted`: Dimmed text.
  - `--accent`: Accent buttons, active highlights, prompts.
  - `--on-accent`: Readable text on top of the accent color.
  - `--ok`: Success/compatible states.
  - `--blocking`: Errors/incompatible states.
  - `--warn`: Warning/advisory states.
  - `--unverified`: Unverified specs status.
- **`ansi`**: Terminal color codes (integers from `0` to `255`) corresponding to:
  - `accent`, `ok`, `blocking`, `warn`, `unverified`, `muted`.

#### WCAG AA Contrast Enforcement
To ensure accessibility, the validation script enforces WCAG AA contrast ratio standards. Your hex tokens must meet or exceed the following ratios:
- `--text` vs `--bg` (minimum **4.5:1**)
- `--text-secondary` vs `--bg` (minimum **4.5:1**)
- `--accent` vs `--bg` (minimum **3.0:1**)
- `--on-accent` vs `--accent` (minimum **4.5:1**)
- `--text` vs `--surface` (minimum **4.5:1**)

#### Walkthrough: Adding a Theme
1. Create a new JSON file: `data/themes/nord-dark.json`.
2. Populate the file with theme colors, ensuring correct HEX patterns (`^#[0-9A-Fa-f]{6}$`) and matching ANSI color codes:
   ```json
   {
     "$schema": "../schemas/theme.schema.json",
     "schema_version": 1,
     "theme_name": "nord-dark",
     "mode": "dark",
     "tokens": {
       "--bg": "#2e3440",
       "--surface": "#3b4252",
       "--surface-raised": "#434c5e",
       "--border": "#4c566a",
       "--text": "#eceff4",
       "--text-secondary": "#e5e9f0",
       "--text-muted": "#d8dee9",
       "--accent": "#88c0d0",
       "--on-accent": "#2e3440",
       "--ok": "#a3be8c",
       "--blocking": "#bf616a",
       "--warn": "#ebcb8b",
       "--unverified": "#b48ead"
     },
     "ansi": {
       "accent": 110,
       "ok": 108,
       "blocking": 131,
       "warn": 222,
       "unverified": 139,
       "muted": 246
     }
   }
   ```
3. Run the validation command:
   ```bash
   npm run validate:data
   ```
   If any contrast ratio checks fail, adjust your colors accordingly.

