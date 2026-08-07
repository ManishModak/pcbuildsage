---
name: "Theme Request / Submission"
about: Request or submit a new UI theme for Web and CLI.
title: "theme: [Theme Name]"
labels: good-first-issue, theme
assignees: ''
---

### Theme Details
- **Theme Name:** (e.g. `nord-dark`, `catppuccin-mocha`)
- **Mode:** Dark / Light

### Checklist for Submitting a Theme
- [ ] Theme file created under `data/themes/<theme-name>.json`
- [ ] `$schema` set to `../schemas/theme.schema.json`
- [ ] Runs clean with `npm run validate:data` (WCAG AA contrast compliant)
