## Summary of Changes
Provide a brief summary of what this PR introduces (e.g. new country profile, new UI theme, hardware spec addition, bug fix).

## Category
- [ ] 🏪 **New Retailer / Country Profile** (`data/profiles/`)
- [ ] 📖 **Hardware Spec Registry Entry** (`data/registry/`)
- [ ] 🎨 **UI Theme** (`data/themes/`)
- [ ] 🤖 **Automation / Workflow / CI**
- [ ] 🔧 **Core / CLI / Web Code Fix**

## Verification Checklist
- [ ] Validated data schemas locally via `npm run validate:data`
- [ ] Tested scraper profile via `pcbuildsage test-profile` (if modifying profiles)
- [ ] Verified WCAG AA contrast ratios (if adding a UI theme)
- [ ] Formatted and linted code via `npm run lint` / `ruff check` (if modifying TypeScript/Python)
