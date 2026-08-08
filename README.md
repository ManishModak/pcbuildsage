# PCBuildSage 🧙‍♂️🖥️

**The open-source AI PC part picker & compatibility checker that works in any country.**

Compare live PC component prices from *your local retailers*, chat with an AI build consultant that never hallucinates specs, and get builds that are guaranteed compatible — all running 100% on your own machine.

<!-- badges -->
![License: MIT](https://img.shields.io/badge/license-MIT-green) ![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen) ![GitHub Stars](https://img.shields.io/github/stars/ManishModak/pcbuildsage?style=social) ![Local First](https://img.shields.io/badge/100%25-local--first-blue)

---

## Why PCBuildSage?

If you've ever tried to plan a PC build outside the US, you know the pain:

- **PCPartPicker misses most of the world.** Limited retailer coverage, missing local pricing and stock across Asia, Europe, South America, and beyond.
- **Price aggregators are static spreadsheets.** Numbers but zero guidance on compatibility, bottlenecks, or value.
- **ChatGPT/Gemini hallucinate hardware.** Outdated prices, imaginary stock, confidently wrong compatibility claims.

PCBuildSage fixes all three:

| | |
| :-- | :-- |
| 🌍 **Works anywhere** | Retailers are defined in simple JSON profiles — adding your country is a PR away, **no code required**. |
| 🤖 **AI consultant, real data** | Chat with the LLM of your choice (Gemini, Ollama, OpenRouter, any OpenAI-compatible API). It queries your **local SQLite database** of freshly scraped prices — never its imagination. |
| ✅ **Compatibility you can trust** | A deterministic rules engine checks sockets, DDR generation, PSU wattage, and physical clearances. The AI **cannot override it**. |
| 🔒 **100% local & private** | Your data, your API keys, your machine. No cloud, no accounts, no telemetry. |
| 💻 **Web app *and* terminal** | A friendly web wizard, or an interactive CLI with scriptable subcommands. |

---

## Quick start

> Prerequisites: Node 20+, Python 3.11+

```bash
git clone https://github.com/<org>/pcbuildsage
cd pcbuildsage
npm install
pip install -r scraper/requirements.txt
cp .env.example .env   # then fill in your LLM API keys
```

### Web Application

```bash
npm run dev
```

Open `http://localhost:3000` — the wizard walks you through onboarding, scraping, and building.

### Terminal (CLI)

```bash
npx pcbuildsage
```

First run launches an interactive onboarding wizard, then drops you into a REPL. Type `/help` to see all available commands. Commands also work as one-shot subcommands:

```bash
./bin/pcbuildsage.js ask "₹80,000 Blender + 1440p gaming build, white case"
./bin/pcbuildsage.js validate --parts mybuild.json
```

### Seed Sample Database (Optional)

To quickly populate a sample SQLite database from fixtures without scraping:

```bash
npm run generate-sample-db
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

- **Profiles** describe *how* to scrape each retailer. If selectors break after a site redesign, an AI extraction fallback keeps data flowing.
- **The registry** holds curated component specs (socket, TDP, dimensions) powering compatibility rules. The AI can research brand-new hardware from the web — its findings become draft registry entries the community ratifies.
- **The rules engine is the final authority.** AI proposes; deterministic checks dispose. Every rule is open source and unit-tested.

---

## Contributing — most contributions need zero code

The most valuable contributions are **data files, not code**:

| Contribution | Effort | How |
| :-- | :-- | :-- |
| 🏪 **Add a retailer** (or a whole country!) | ~30 min, JSON only | Copy a profile in `data/profiles/`, adjust URLs + CSS selectors, verify with `node bin/pcbuildsage.js test-profile data/profiles/your_country.json --site RetailerName`. |
| 📖 **Add component specs** | ~5 min per part | Add an entry to `data/registry/`, or run `npm run export-research` to turn the AI's researched specs into a ready-made PR. |
| 🎨 **Add a theme** | ~20 min | One JSON file of color tokens skins the web app *and* the CLI (`data/themes/`). |
| 🔧 **Fix a broken profile** | minutes | Usually a one-selector fix when a retailer redesigns. Great first issue. |
| 💻 **Code** | varies | TypeScript core or Python scraper. See `CONTRIBUTING.md`. |

Every data file has a JSON Schema under `data/schemas/` — your editor autocompletes and CI validates automatically:
```bash
npm run validate:data
```

---

## FAQ

**Is it free?** Yes — MIT licensed, self-hosted. You only pay your own LLM provider (or use free local Ollama).

**Which countries work?** Any country with a community-contributed profile. Adding yours takes minutes with zero code.

**Does it work offline?** Scraped data, search, and compatibility checks are fully offline. Chat needs whatever your LLM needs (local Ollama = fully offline).

**Is my data private?** Everything stays on your machine. Keys are sent only to the LLM provider you configure.

---

## Roadmap

- [ ] 🎮 **FPS & Workload Estimator** — Deterministic FPS and benchmark estimation from component specs.
- [ ] 📏 **Advanced 3D Spatial Clearance Engine** — GPU vs radiator, RAM vs cooler, PSU vs drive cages.
- [ ] 🛠️ **In-App Profile Manager** — Inspect, test, and sync community profiles from the UI.
- [ ] 📄 **Export & Share** — Markdown, Reddit markup, HTML, and JSON export.
- [ ] 🧩 **Self-Healing Scraper** — Automatic LLM selector recovery when store layouts change.

---

## ⭐ Show Your Support

If PCBuildSage is useful to you, please **Star** ⭐ the repo — it helps more builders find us.

## License

MIT © PCBuildSage contributors
