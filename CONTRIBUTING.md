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

## 5. Adding Build Personas & UI Themes

You can customize the advice of the AI builder and the visual skin of both the Web and CLI interfaces by adding personas and themes.

### 🎭 Build Personas

Build personas shape how the AI allocates budgets across different PC components and its conversational tone. They are defined in JSON files located under `data/personas/` and validated against the schema `data/schemas/persona.schema.json`.

#### Schema Fields
- **`$schema`**: Points to `../schemas/persona.schema.json`.
- **`persona_name`**: A readable title for the persona (e.g., `"Silent Workstation"`).
- **`description`**: A short explanation of the build priority.
- **`budget_weights`**: Weight coefficients for 8 required component categories (`gpu`, `cpu`, `motherboard`, `ram`, `storage`, `psu`, `case`, `cooler`). **Crucial: The sum of all weights must equal exactly 1.0** (with a tolerance of 0.001).
- **`priorities`**: An array of key features prioritized by the persona (e.g., `["quiet fans", "excellent thermals"]`).
- **`tone`**: Brief instruction detailing the AI's speaking tone (e.g., `"conservative, detail-oriented, quiet"`).

#### Walkthrough: Adding a Build Persona
1. Create a new JSON file: `data/personas/silent-workstation.json`.
2. Populate the file with valid JSON following the schema, ensuring the budget weights sum to exactly `1.0`:
   ```json
   {
     "$schema": "../schemas/persona.schema.json",
     "persona_name": "Silent Workstation",
     "description": "Prioritizes low noise levels, efficient cooling, and productivity.",
     "budget_weights": {
       "gpu": 0.20,
       "cpu": 0.25,
       "motherboard": 0.12,
       "ram": 0.10,
       "storage": 0.10,
       "psu": 0.10,
       "case": 0.08,
       "cooler": 0.05
     },
     "priorities": [
       "near-silent operation",
       "reliable and efficient cooling",
       "high-quality multi-core CPU",
       "gold-rated silent PSU"
     ],
     "tone": "helpful, noise-conscious, and technical"
   }
   ```
3. Run the validation tool to verify:
   ```bash
   npm run validate:data
   ```

---

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

