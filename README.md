# PCBuildSage 🧙‍♂️🖥️

**Plan a PC in plain language, using only parts in stock at Indian retailers today, with exact totals, buy links, and compatibility checked by code, not the AI.**

India is supported today. More countries are coming, and contributions are welcome: a retailer is one JSON profile, no code required.

<!-- badges -->
![License: MIT](https://img.shields.io/badge/license-MIT-green) ![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen) ![GitHub Stars](https://img.shields.io/github/stars/ManishModak/pcbuildsage?style=social) ![Privacy First](https://img.shields.io/badge/privacy--first-blue)

🌐 **Live demo:** [pcbuildsage.onrender.com](https://pcbuildsage.onrender.com). It runs on free hosting, so the first visit after a quiet spell can take about a minute to wake up. Bring a free Gemini or OpenRouter API key.

---

## Why PCBuildSage?

A chatbot with web search can talk about PC parts, but it only sees the pages its search happens to find, and it does the maths itself. Indian price-comparison sites see real stock, but you can't tell them "I already own an RTX 4070, build a quiet PC around it". PCBuildSage does both: you describe what you want, and an AI consultant builds from the whole in-stock catalog, while code handles the totals and the compatibility checks.

| | Chatbot with web search | Indian price-comparison sites | PCBuildSage |
| :-- | :-- | :-- | :-- |
| Describe your needs in plain language | ✅ | ❌ | ✅ |
| Sees every in-stock listing in a price range | ❌ only the pages a search finds | ✅ | ✅ refreshed twice a day |
| Exact totals | ❌ the model does the maths | ✅ | ✅ computed by code |
| Compatibility checked by code | ❌ | ✅ | ✅ rules the AI can't override |
| Buy links to real listings | sometimes | ✅ | ✅ |
| Performance data (benchmarks) | ✅ general knowledge | some | planned |
| Runs locally with your own model | ❌ | ❌ | ✅ |
| Setup | none | none | a free API key (demo) or a local install |

What you get:

| | |
| :-- | :-- |
| 🇮🇳 **India today, more coming** | Retailers are defined in JSON profiles. Adding a retailer or a whole country is a pull request, no code required. |
| 🤖 **AI consultant, real data** | Chat with the model of your choice (Gemini, OpenRouter, Groq, Ollama, any OpenAI-compatible API). It searches freshly scraped listings, never its memory. |
| ✅ **One more trust layer** | The AI proposes parts; a deterministic rules engine checks sockets, DDR generation, PSU wattage and physical clearances before a build is presented. Anything it can't verify is shown as unverified. The engine is young: if you spot a wrong verdict, please [open an issue](https://github.com/ManishModak/pcbuildsage/issues). |
| 🔒 **Private** | No accounts and no tracking. Run it 100% locally, or use the demo, where your key and chats stay in your browser. |
| 💻 **Web app and terminal** | A friendly web wizard, or an interactive CLI with scriptable subcommands. |

---

## Hosted demo

[pcbuildsage.onrender.com](https://pcbuildsage.onrender.com):

- **India catalog**, refreshed twice a day from Indian retailers such as MDComputers, PrimeABGB, Vedant Computers, PC Studio and Kryptronix.
- **Bring your own key.** Use a free key from [Google AI Studio](https://aistudio.google.com/app/apikey) (Gemini) or [OpenRouter](https://openrouter.ai/keys), which has free models. The demo never uses server-side keys.
- **Your key stays in your browser.** It's kept in this tab's session storage and sent with each request only to reach your provider. It's never written to disk, stored in a database, or logged on the server.
- **Your chats stay in your browser** too (IndexedDB). The server keeps no sessions.

---

## Quick start (local)

> Prerequisites: Node 20+, Python 3.11+

```bash
git clone https://github.com/ManishModak/pcbuildsage
cd pcbuildsage
npm install
pip install -r scraper/requirements.txt
cp .env.example .env   # then fill in your LLM API keys
```

### Web app

```bash
npm run dev
```

Open `http://localhost:3000`. The wizard walks you through setup, scraping, and building.

Local mode has no login and holds your `.env` keys, so it only listens on `127.0.0.1`, and its API refuses requests from other websites or other host names. To use it from another device on your network on purpose, run `npx next dev --webpack -H 0.0.0.0` and list the host names you'll use in `PCBUILDSAGE_ALLOWED_HOSTS` (comma-separated, e.g. `192.168.1.20,desk.lan`). Anyone on that network can then use it.

### Terminal (CLI)

```bash
node bin/pcbuildsage.js
```

The first run launches an interactive setup, then drops you into a REPL. Type `/help` to see all commands. Commands also work one-shot:

```bash
node bin/pcbuildsage.js ask "₹80,000 Blender + 1440p gaming build, white case"
node bin/pcbuildsage.js validate --parts mybuild.json
```

Run `npm link` once if you'd rather type `pcbuildsage` instead of `node bin/pcbuildsage.js`.

### Sample database (optional)

To try it without scraping, generate a small sample catalog from fixtures:

```bash
npm run generate-sample-db
```

### Docker (self-hosting)

The container runs in hosted-demo mode by default and listens on port 10000. For local mode, set `PCBUILDSAGE_DEPLOYMENT_MODE=local`:

```bash
docker build -t pcbuildsage .
docker run -d -p 127.0.0.1:3000:10000 -e PCBUILDSAGE_DEPLOYMENT_MODE=local pcbuildsage
```

Then open http://localhost:3000.

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
- **The registry** holds curated component specs (socket, TDP, dimensions) with their sources. The AI can research brand-new hardware on the web; its findings become draft registry entries that contributors review.
- **The rules engine has the last word on compatibility.** The AI proposes; deterministic checks review. Every rule is open source and unit-tested.

---

## Contributing: most contributions need zero code

The most valuable contributions are **data files, not code**:

| Contribution | Effort | How |
| :-- | :-- | :-- |
| 🌍 **Add your country** | an evening, JSON only | Write a profile for a few retailers in `data/profiles/`. See [CONTRIBUTING.md](CONTRIBUTING.md#2-add-a-retailer-or-a-country). |
| 🏪 **Add a retailer** | ~30 min, JSON only | Copy a site block in a profile, adjust URLs and CSS selectors, check it with `node bin/pcbuildsage.js test-profile data/profiles/india.json --site RetailerName`. |
| 📖 **Add component specs** | ~5 min per part | Add an entry to `data/registry/` with its source URL, or run `npm run export-research` to turn the AI's researched specs into draft entries. |
| 🎨 **Add a theme** | ~20 min | One JSON file of color tokens skins the web app *and* the CLI (`data/themes/`). |
| 🔧 **Fix a broken profile** | minutes | Usually a one-selector fix when a retailer redesigns. Great first issue. |
| 💻 **Code** | varies | TypeScript core or Python scraper. See [CONTRIBUTING.md](CONTRIBUTING.md). |

Every data file has a JSON Schema under `data/schemas/`, so your editor autocompletes and CI validates automatically:

```bash
npm run validate:data
```

---

## FAQ

**Is it free?** Yes, MIT licensed. You only pay your own LLM provider, or nothing at all with a free key or a local Ollama model.

**Which countries work?** India today. Adding a country means writing retailer profiles (JSON, no code), and we'd love the help. See [CONTRIBUTING.md](CONTRIBUTING.md#2-add-a-retailer-or-a-country).

**Why does the demo ask for an API key?** The demo runs on free hosting with no budget for AI usage, so you bring your own key. Gemini and OpenRouter both offer free keys.

**Does it work offline?** Scraped data, search, and compatibility checks work fully offline. Chat needs whatever your model needs (a local Ollama model is fully offline).

**Is my data private?** Yes. Locally, all data, databases, and keys stay on your machine. On the demo, chats stay in your browser, and your key lives in this tab's session storage. It's sent with each request only to reach your provider, and never written to disk, stored, or logged on the server.

**Found a security issue?** Please report it privately; see [SECURITY.md](SECURITY.md).

---

## ⭐ Show your support

If PCBuildSage is useful to you, please **star** the repo. It helps more builders find it.

## License

MIT © PCBuildSage contributors
