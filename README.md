# PCBuildSage 🧙‍♂️🖥️

**The open-source AI PC part picker & compatibility checker that works in any country.**

Compare live PC component prices from *your local retailers*, chat with an AI build consultant that never hallucinates specs, and get builds that are guaranteed compatible — all running 100% on your own machine.

<!-- badges -->
![License: MIT](https://img.shields.io/badge/license-MIT-green) ![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen) ![Local First](https://img.shields.io/badge/100%25-local--first-blue)

<!-- demo -->
<p align="center"><em>📸 demo GIF here — wizard → scrape progress → chat recommending a build</em></p>

---

## Why PCBuildSage?

If you've ever tried to plan a PC build outside the US, you know the pain:

- **PCPartPicker doesn't cover your country.** No Indian retailers, no local pricing, no local stock. Most of the world builds PCs blind.
- **Price aggregators are static spreadsheets.** They show numbers but offer zero guidance on compatibility, bottlenecks, or value.
- **ChatGPT/Gemini hallucinate hardware.** Ask a chatbot for a build and you'll get outdated prices, imaginary stock, and confidently wrong compatibility claims.

PCBuildSage fixes all three:

| | |
| :-- | :-- |
| 🌍 **Works anywhere** | Retailers are defined in simple JSON profiles. India ships out of the box; adding your country is a pull request away — **no code required**. |
| 🤖 **AI consultant, real data** | Chat with the LLM of your choice (Gemini, Ollama, OpenRouter, any OpenAI-compatible API). It queries your **local SQLite database** of freshly scraped prices — never its imagination. |
| ✅ **Compatibility you can trust** | A deterministic, open-source rules engine checks sockets, DDR generation, PSU wattage, and physical clearances. The AI **cannot override it** — no hallucinated builds, ever. |
| 🔒 **100% local & private** | Your data, your API keys, your machine. No cloud, no accounts, no telemetry. |
| 💻 **Web app *and* terminal** | A friendly web wizard, or a Claude Code-style interactive CLI (`pcbuildsage`) with scriptable subcommands. |

---

## Quick start

> Prerequisites: Node 20+, Python 3.11+

### Installation

```bash
git clone https://github.com/<org>/pcbuildsage
cd pcbuildsage
npm install
pip install -r src/scraper/requirements.txt
```

### Configuration

Copy `.env.example` to `.env` and fill in the necessary keys. The application supports multiple environment variables:

- `GEMINI_API_KEY`: API key for Google Gemini (primary recommended model).
- `OPENROUTER_API_KEY`: API key for OpenRouter models.
- `OLLAMA_BASE_URL`: Base URL of your local Ollama instance (defaults to `http://localhost:11434`).
- `LLM_CHAIN`: Configuration for LLM fallbacks (e.g. `gemini:gemini-2.5-flash,ollama:llama3.3`).
- `SCRAPER_LLM_PROVIDER`: LLM provider for the Python scraper extraction fallback (defaults to `gemini`).
- `SCRAPER_LLM_MODEL`: Model name for scraper extraction fallback (defaults to `gemini-2.5-flash-lite`).
- `SEARCH_PROVIDER`: Web search grounding provider (`exa`, `tavily`, `brave`, `searxng`, `duckduckgo`, `gemini-native`, or `none`).
- `EXA_API_KEY`, `TAVILY_API_KEY`, `BRAVE_API_KEY`: API credentials for respective search providers.
- `SEARXNG_BASE_URL`: Base URL for local SearXNG search instance.
- `PYTHON_PATH`: Path to the Python executable (if not automatically resolved).
- `SEED_RELEASE_URL`: Custom base URL to override the default seed release location.

---

### Option A — Web Application

Start the development server:

```bash
npm run dev
```

Open `http://localhost:3000` in your browser. The web wizard will guide you through onboarding (configuring LLM credentials and profiles), downloading seed data or scraping fresh prices, and building your PC list.

The frontend is powered by a robust Next.js API backend interacting with these endpoints:
- `POST` `/api/chat`: Handles interactive streaming chat and tool calls with the AI.
- `GET` `/api/config`: Inspects local API credentials availability status.
- `GET` `/api/endpoints`: Lists preset endpoint configurations for OpenAI-compatible providers.
- `POST` `/api/export-research`: Exports LLM-researched component specifications to registry PRs.
- `POST` `/api/llm/probe`: Probes and verifies LLM connection/keys.
- `GET` `/api/models`: Fetches available models for a given provider.
- `GET` `/api/personalities`: Returns available chat personalities.
- `GET` `/api/personas`: Returns available build personas (e.g., Frame Chaser, Balanced Showpiece).
- `GET` `/api/profiles` / `POST` `/api/profiles/import` / `POST` `/api/profiles/test`: Inspect, import, and test CSS selectors on retailer profiles.
- `POST` `/api/scrape`: Initiates the Python scraper worker.
- `POST` `/api/seed`: Initiates the seed dataset downloader (returns SSE progress stream).
- `GET` `/api/status`: Retrieves general database initialization and scraper status.
- `GET` `/api/themes`: Fetches UI theme tokens.
- `POST` `/api/validate`: Runs deterministic compatibility checks on build lists.

---

### Option B — Terminal (CLI)

You can run the interactive CLI:

```bash
# Using npx (from the project directory)
npx pcbuildsage

# Or executing the bin entrypoint directly
./bin/pcbuildsage.js
```

If it is your first run and no configuration exists, the CLI automatically launches an interactive **onboarding wizard** to set up LLM keys and scrape profiles, followed by a REPL (read-eval-print loop).

#### CLI REPL Slash Commands
Within the interactive REPL (`pcbuildsage>`), type `/help` to see the available commands:
- `/ask "<query>" [--persona id] [--json]` — Ask a single query and exit.
- `/scrape --profile <name> [--categories csv] [--quick]` — Run the Python scraper.
- `/provider [provider:model]` — Show or switch the primary LLM chain.
- `/models --provider <provider> [--base-url url]` — List models for a provider.
- `/persona [id]` — Show or switch the active build persona.
- `/personality [id]` — Show or switch the chat personality.
- `/audit on|off` — Toggle Tier 2 advisory audit.
- `/search [provider|off]` — Show or switch the grounding search provider.
- `/export-research [--output-dir path]` — Export registry research as PR-ready JSON.
- `/theme [id]` — Show or switch the terminal theme.
- `/test-profile <file> [--site name]` — Run scraper selector checks without DB writes.
- `/validate --parts build.json [--json]` — Run deterministic Tier 1 validation.
- `/config get|set <key> [value]` — Manage configuration settings stored in `.pcbuildsage/config.json`.
- `/seed --country <ISO-2>` — Download a seed dataset.
- `/help` — List interactive commands.
- `/exit` — Exit the REPL.

#### CLI Subcommand/One-shot Mode
All commands can also be run directly from your terminal as subcommands:
```bash
# Query the builder directly and exit
./bin/pcbuildsage.js ask "I have ₹80,000 for a Blender + 1440p gaming build, prefer white case"

# Export research entries
./bin/pcbuildsage.js export-research --output-dir ./draft-specs

# Run Tier 1 validation on a build file
./bin/pcbuildsage.js validate --parts mybuild.json
```

---

### Seed Database Downloading

First run, the wizard offers a way to get data by downloading a seed dataset for your country (e.g., `IN` for India). 

> [!IMPORTANT]
> **Seed Download Status:** The official community seed dataset release artifacts are not yet published. However, the seed downloader is fully implemented. You can test seed downloads by configuring the `SEED_RELEASE_URL` environment variable to point to a custom hosting URL containing pre-built `products-${country}.db` SQLite databases (or passing `--url <url>` to the download helper script/CLI).

To run the seed downloader directly via script:
```bash
npx tsx scripts/seed-download.ts --country IN [--output data/products.db] [--url <release-url-override>]
```

---

## How it works

```
data/profiles/*.json ──▶ Python scraper (Crawl4AI) ──▶ SQLite (products.db)
   community-made          CSS selectors + AI fallback         │
                                                               ▼
data/registry/*.json ──▶ deterministic rules engine ◀── AI chat consultant
   community spec DB       sockets · DDR · wattage · fit      (your LLM, via tools)
                                     ▲
                       web-grounded AI research fills gaps
                       for brand-new hardware (advisory only)
```

- **Profiles** describe *how* to scrape each retailer (selectors, pagination, browser settings). If selectors break after a site redesign, an AI extraction fallback keeps data flowing until someone submits a one-line fix.
- **The registry** holds curated component specs (socket, TDP, dimensions) that power the compatibility rules. When a brand-new CPU launches, the AI researches its specs from the web — and its findings become draft registry entries the community ratifies.
- **The rules engine is the final authority.** AI proposes; deterministic checks dispose. Every rule is open source and unit-tested, so recommendations are verifiably unbiased.

---

## Contributing — most contributions need zero code

This project is designed so that the most valuable contributions are **data files, not code**:

| Contribution | Effort | How |
| :-- | :-- | :-- |
| 🏪 **Add a retailer** (or a whole country!) | ~30 min, JSON only | Copy a profile in `data/profiles/`, adjust URLs + CSS selectors, verify with `node bin/pcbuildsage.js test-profile data/profiles/your_country.json --site RetailerName` — it prints selector hit rates so you know it works before you open the PR. |
| 📖 **Add component specs** | ~5 min per part | Add an entry to `data/registry/` (socket, TDP, dimensions). Even easier: run `node bin/pcbuildsage.js export-research` or `npm run export-research` to turn the AI's researched specs into a ready-made PR. |
| 🎭 **Add a build persona** | ~10 min | A JSON file with budget weights + priorities (`data/personas/`) — e.g. "SFF enthusiast" or "silent workstation". Checked against schema and validated by `npm run validate:data`. |
| 🎨 **Add a theme** | ~20 min | One JSON file of color tokens skins the web app *and* the CLI (`data/themes/`) — Nord, Gruvbox, Catppuccin, OLED black… Validated via `npm run validate:data` (which auto-checks contrast). |
| 🔧 **Fix a broken profile** | minutes | CI pings us when a retailer redesign breaks selectors; usually a one-selector fix. Great first issue. |
| 💻 **Code** | varies | TypeScript core (chat engine, rules, CLI) or Python scraper. See `CONTRIBUTING.md` for architecture. |

Every data file has a JSON Schema under `data/schemas/`, so your editor autocompletes and CI validates automatically. Run data checks locally via:
```bash
npm run validate:data
```

Look for `good first issue` and `profile request` labels in our repository.

---

## FAQ

**Is it free?** Yes — MIT licensed, self-hosted. You only pay your own LLM provider (or use free local Ollama).

**Which countries work?** Any country someone has written a profile for. India ships first; the whole point is that yours is easy to add.

**Does it work offline?** Scraped data, product search, and the compatibility engine are fully offline (web-search grounding for brand-new hardware is optional and needs a provider). Chat needs whatever your chosen LLM needs (local Ollama = fully offline).

**Is my data private?** Everything — prices, chats, API keys — stays on your machine. Keys are sent only to the LLM provider you configure, and are never logged.

**How is this different from PCPartPicker?** PCPartPicker is a closed platform with fixed country coverage. PCBuildSage is open source, works anywhere the community adds profiles, runs locally, and adds an AI consultant with a verifiable compatibility guarantee.

---

## Roadmap

- [ ] **Roast & Fix** — paste any part list, get a graded critique with cheaper/better alternatives
- [ ] Multi-persona builds side by side (Frame Chaser vs. Upgrade Path)
- [ ] Price history tracking & alerts
- [ ] More seed datasets (help wanted!)

## License

MIT © PCBuildSage contributors
