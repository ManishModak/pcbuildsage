---
name: "Profile Broken: <site>"
about: Report a broken profile where selectors fail to extract data.
title: "profile broken: [Site Name]"
labels: bug, profile-broken
assignees: ''
---

### Affected Profile & Site
- **Profile Name (e.g. india.json):**
- **Broken Site (e.g. Kryptronix):**
- **Broken Selectors / Fields:** (e.g. Title, Price, URL, Image)

### Error Output / Test Profile Results
Paste the output of `pcbuildsage test-profile <profile> --site <site>` showing the hit rate failure:
```
[Paste output here]
```

### Steps to Reproduce
1. Run command: `pcbuildsage test-profile [profile] --site [site]`
2. See hit rates:

### Possible Fix / Suggestions
If you know the new CSS selectors, please suggest them here:
- `product_container`:
- `title`:
- `price`:
- `url`:
- `image`:
- `out_of_stock`:
