# PCBuildSage 🧙‍♂️🖥️

**The open-source AI PC part picker & compatibility checker that works in any country.**

Compare live PC component prices from *your local retailers*, chat with an AI build consultant that never hallucinates specs, and get builds that are guaranteed compatible — run 100% locally on your machine or explore the stateless hosted demo.

<!-- badges -->
![License: MIT](https://img.shields.io/badge/license-MIT-green) ![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen) ![GitHub Stars](https://img.shields.io/github/stars/ManishModak/pcbuildsage?style=social) ![Privacy First](https://img.shields.io/badge/privacy--first-blue)

🌐 **Live Demo:** [https://pcbuildsage.onrender.com](https://pcbuildsage.onrender.com)

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
| 🤖 **AI consultant, real data** | Chat with the LLM of your choice (Gemini, Ollama, OpenRouter, any OpenAI-compatible API). It queries freshly scraped prices from catalog repositories — never its imagination. |
| ✅ **Compatibility you can trust** | A deterministic rules engine checks sockets, DDR generation, PSU wattage, and physical clearances. The AI **cannot override it**. |
| 🔒 **Private & Stateless** | 100% local by default, or run via the hosted demo. In both modes: zero accounts, no tracking, and your API keys never touch server disk. |
| 💻 **Web app *and* terminal** | A friendly web wizard, or an interactive CLI with scriptable subcommands. |

---

## Hosted Demo

A public live demonstration is available at [https://pcbuildsage.onrender.com](https://pcbuildsage.onrender.com). The hosted demo runs in a dedicated stateless mode with strict privacy boundaries:

- **Bring-Your-Own-Key (BYOK)**: Visitors provide their own API key (e.g. Gemini, OpenRouter, Groq). In hosted mode, the backend strictly ignores server environment keys, ensuring visitor requests execute exclusively against visitor-provided keys ([`src/app/api/_lib/credentials.ts`](src/app/api/_lib/credentials.ts), [`src/lib/config/deployment.ts`](src/lib/config/deployment.ts)).
- **Keys Stored in Browser Only**: API keys are saved in browser `sessionStorage` (scoped to tab lifetime). Keys are forwarded per-request through the server in headers to execute LLM calls, but are never written to disk, stored in any database, or logged on the server ([`src/lib/llm/client-byok-store.ts`](src/lib/llm/client-byok-store.ts)).
- **Stateless Sessions**: Chat sessions and build recommendations live entirely in the browser using client-side IndexedDB and `localStorage`. The server operates on an ephemeral read-only filesystem with zero server session database or disk persistence ([`src/lib/sessions/client-store.ts`](src/lib/sessions/client-store.ts), [`tests/container/dockerfile.test.ts`](tests/container/dockerfile.test.ts)).
- **India-Only Catalog**: The hosted catalog currently ingests and serves in-stock hardware pricing exclusively for the Indian market (`IN`). Market selection dynamically presents only markets with verified in-stock catalog records ([`src/lib/catalog/sql-repository.ts`](src/lib/catalog/sql-repository.ts), [`src/app/api/markets/route.ts`](src/app/api/markets/route.ts)).

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

### Docker (Self-Hosting)

The container runs in hosted-demo mode by default. To run it in local mode, set `-e PCBUILDSAGE_DEPLOYMENT_MODE=local`:

```bash
docker run -d -p 3000:3000 -e PCBUILDSAGE_DEPLOYMENT_MODE=local pcbuildsage
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

**Is my data private?** Yes. When running locally, all data, databases, and keys stay 100% on your machine. On the hosted demo, your sessions remain in your browser's local storage and your BYOK API keys are kept in ephemeral browser memory (`sessionStorage`). Keys are forwarded per-request through the server in headers to execute LLM calls, but are never written to disk, stored in any database, or logged on the server.

---

## ⭐ Show Your Support

If PCBuildSage is useful to you, please **Star** ⭐ the repo — it helps more builders find us.

## License

MIT © PCBuildSage contributors
