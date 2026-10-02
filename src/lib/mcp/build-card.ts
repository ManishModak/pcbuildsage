/**
 * src/lib/mcp/build-card.ts
 *
 * The build card as an MCP App UI resource (ui://). present_build links to it
 * through _meta.ui.resourceUri; an MCP Apps host renders the HTML in a
 * sandboxed iframe and pushes present_build's result to it (ontoolresult).
 * The card reads structuredContent.cards, which server.ts adds from the
 * session's validate_build snapshots.
 *
 * The view runs the official ext-apps App class. Sandboxed iframes can't load
 * scripts from elsewhere, so the self-contained app-with-deps bundle is
 * inlined, with its trailing ESM export rewritten into a local binding.
 * next.config.ts traces that file into the standalone build.
 */
import fs from "node:fs";
import path from "node:path";

export const BUILD_CARD_URI = "ui://pcbuildsage/build-card";

const APP_BUNDLE_PATH = path.join(process.cwd(), "node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js");

let cachedHtml: string | undefined;

/** Turns the bundle's final `export{a as App,...}` into `const __extApps={App:a,...}`. */
export function inlineAppBundle(bundle: string): string {
  const match = bundle.match(/export\{([^}]*)\};?\s*$/);
  if (!match) throw new Error("ext-apps bundle has no trailing export statement");
  const bindings = match[1]
    .split(",")
    .map((pair) => pair.trim().split(/\s+as\s+/))
    .map(([local, exported]) => `${exported ?? local}:${local}`)
    .join(",");
  return `${bundle.slice(0, match.index)}\nconst __extApps={${bindings}};`;
}

const VIEW_SCRIPT = String.raw`
const { App } = __extApps;
const root = document.getElementById("root");
const money = (n, currency) => {
  if (typeof n !== "number") return "price unknown";
  const code = String(currency || "INR").toUpperCase();
  try {
    return new Intl.NumberFormat(code === "INR" ? "en-IN" : undefined, { style: "currency", currency: code, maximumFractionDigits: code === "INR" ? 0 : 2 }).format(n);
  } catch {
    return code + " " + n.toLocaleString();
  }
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function render(cards) {
  if (!Array.isArray(cards) || cards.length === 0) {
    root.innerHTML = '<p class="muted">No build to show.</p>';
    return;
  }
  root.innerHTML = cards.map((card, i) => {
    const s = card.snapshot ?? {};
    const rows = (s.components ?? []).map((c) =>
      '<tr><td class="cat">' + esc(c.category) + '</td><td>' + esc(c.name) +
      (c.retailer ? ' <span class="muted">· ' + esc(c.retailer) + '</span>' : '') +
      '</td><td class="price">' + (c.included ? 'included' : c.url
        ? '<a href="#" data-url="' + esc(c.url) + '">' + money(c.price, c.currency) + '</a>'
        : money(c.price, c.currency)) + '</td></tr>').join("");
    const v = s.validation_summary;
    const checks = v ? v.passed + ' checks passed' + (v.unverified ? ', ' + v.unverified + ' unverified' : '') + (v.skipped ? ', ' + v.skipped + ' skipped' : '') : '';
    const notes = (v?.issues ?? []).map((issue) => '<li>' + esc(issue) + '</li>').join("");
    return '<section><header><h2>' + esc(card.label) + '</h2><span class="total">' + (s.total == null ? 'total incomplete' : money(s.total, s.currency)) + '</span></header>' +
      (card.notes ? '<p class="muted">' + esc(card.notes) + '</p>' : '') +
      '<table>' + rows + '</table><p class="ok">' + esc(checks) + '</p>' +
      (notes ? '<ul class="issues">' + notes + '</ul>' : '') + '</section>';
  }).join("");
}

const app = new App({ name: "PCBuildSage build card", version: "0.1.0" }, {});
app.ontoolresult = (result) => render(result.structuredContent?.cards);
root.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-url]");
  if (!link) return;
  event.preventDefault();
  app.openLink({ url: link.dataset.url });
});
await app.connect();
`;

const STYLES = `
  :root { color-scheme: light dark; --fg: #1a1a1a; --muted: #666; --line: #e3e3e3; --ok: #1d7a3a; --accent: #2457c5; }
  @media (prefers-color-scheme: dark) { :root { --fg: #eee; --muted: #9a9a9a; --line: #333; --ok: #5cc27a; --accent: #7ea6ff; } }
  body { margin: 0; font: 14px/1.4 system-ui, sans-serif; color: var(--fg); background: transparent; }
  section { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin: 8px 0; }
  header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  h2 { font-size: 16px; margin: 0; }
  .total { font-weight: 600; font-size: 16px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  td { padding: 4px 0; border-top: 1px solid var(--line); vertical-align: top; }
  .cat { color: var(--muted); text-transform: uppercase; font-size: 11px; width: 90px; }
  .price { text-align: right; white-space: nowrap; padding-left: 8px; }
  a { color: var(--accent); }
  .muted { color: var(--muted); }
  .ok { color: var(--ok); margin: 8px 0 0; font-size: 12px; }
  .issues { margin: 6px 0 0; padding-left: 18px; font-size: 12px; color: var(--muted); }
`;

/** The card's HTML document, built once per process. */
export function buildCardHtml(): string {
  cachedHtml ??= `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${STYLES}</style></head><body><div id="root"><p class="muted">Loading build…</p></div><script type="module">${inlineAppBundle(fs.readFileSync(APP_BUNDLE_PATH, "utf8"))}\n${VIEW_SCRIPT}</script></body></html>`;
  return cachedHtml;
}
