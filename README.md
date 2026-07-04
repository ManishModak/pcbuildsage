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

```bash
git clone https://github.com/<org>/pcbuildsage
cd pcbuildsage
npm install
pip install -r src/scraper/requirements.txt

# Option A — web app
npm run dev            # open http://localhost:3000, the wizard takes it from there

# Option B — terminal
npx pcbuildsage        # interactive REPL: onboarding → scrape → chat
```

First run, the wizard offers three ways to get data:

1. **Download a seed dataset** for your country (fastest — chatting in under a minute),
2. **Scrape fresh prices** from local retailers (a "Quick" scrape takes a few minutes), or
3. **Load an existing** `products.db`.

Then pick your LLM (bring your own key, or point at local Ollama — with an optional fallback chain) and start building:

```
> I have ₹80,000 for a Blender + 1440p gaming build, prefer white case

⚒ search_products {category: "gpu", max_price: …}
⚒ validate_build → ✅ all checks passed

Here's my recommendation, with two alternates…
```

One-shot mode for scripts: `pcbuildsage ask "best GPU under ₹30k" --json`

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
| 🏪 **Add a retailer** (or a whole country!) | ~30 min, JSON only | Copy a profile in `data/profiles/`, adjust URLs + CSS selectors, verify with `pcbuildsage test-profile` — it prints selector hit rates so you know it works before you open the PR. |
| 📖 **Add component specs** | ~5 min per part | Add an entry to `data/registry/` (socket, TDP, dimensions). Even easier: run `pcbuildsage export-research` to turn the AI's researched specs into a ready-made PR. |
| 🎭 **Add a build persona** | ~10 min | A JSON file with budget weights + priorities (`data/personas/`) — e.g. "SFF enthusiast" or "silent workstation". |
| 🎨 **Add a theme** | ~20 min | One JSON file of color tokens skins the web app *and* the CLI (`data/themes/`) — Nord, Gruvbox, Catppuccin, OLED black… CI auto-checks contrast so you can't break accessibility. |
| 🔧 **Fix a broken profile** | minutes | CI pings us when a retailer redesign breaks selectors; usually a one-selector fix. Great first issue. |
| 💻 **Code** | varies | TypeScript core (chat engine, rules, CLI) or Python scraper. See `CONTRIBUTING.md` for architecture. |

Every data file has a JSON Schema, so your editor autocompletes and CI validates automatically. Look for [`good first issue`](../../labels/good%20first%20issue) and [`profile request`](../../labels/profile%20request) labels.

---

## FAQ

**Is it free?** Yes — MIT licensed, self-hosted. You only pay your own LLM provider (or use free local Ollama).

**Which countries work?** Any country someone has written a profile for. India ships first; the whole point is that yours is easy to add.

**Does it work offline?** Scraped data, search, and the compatibility engine are fully offline. Chat needs whatever your chosen LLM needs (local Ollama = fully offline).

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
