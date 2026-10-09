/**
 * src/lib/mcp/card/view.ts
 *
 * The MCP build card view: styles plus the two inline scripts that make up
 * the served card document (assembled by ../build-card.ts).
 *
 * CARD_SCRIPT is the pure view. It defines `PCBuildSageCard` from the passed
 * `document` and nothing else (no App, no network), so the exact code shipped
 * inside the iframe can be executed in tests under happy-dom:
 *
 *   const view = new Function("document", CARD_SCRIPT + "\nreturn PCBuildSageCard;")(document);
 *
 * Because the script travels as a TS template literal, it must not contain
 * backticks, `${`, or the literal sequence `</script>`.
 *
 * CARD_BOOT_SCRIPT wires the view to the official ext-apps App: tool results
 * in, buy-link clicks out through `openLink`, host theme in through
 * `onhostcontextchanged`/`getHostContext()` with a `prefers-color-scheme`
 * fallback, and height reporting out through App's autoResize.
 */

export const CARD_STYLES = `
  :root { color-scheme: light dark; --fg: #1a1a1a; --muted: #666; --line: #e3e3e3; --ok: #1d7a3a; --accent: #2457c5; --on-accent: #fff; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme]) { color-scheme: dark; --fg: #eee; --muted: #9a9a9a; --line: #333; --ok: #5cc27a; --accent: #7ea6ff; --on-accent: #0b0b0c; }
  }
  :root[data-theme="light"] { color-scheme: light; --fg: #1a1a1a; --muted: #666; --line: #e3e3e3; --ok: #1d7a3a; --accent: #2457c5; --on-accent: #fff; }
  :root[data-theme="dark"] { color-scheme: dark; --fg: #eee; --muted: #9a9a9a; --line: #333; --ok: #5cc27a; --accent: #7ea6ff; --on-accent: #0b0b0c; }
  body { margin: 0; font: 14px/1.4 system-ui, sans-serif; color: var(--fg); background: transparent; }
  .tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 4px; }
  .tab { appearance: none; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 999px; padding: 4px 12px; font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; }
  .tab[aria-selected="true"] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
  section { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin: 8px 0; }
  header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  h2 { font-size: 16px; margin: 0; }
  .total { font-weight: 600; font-size: 16px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  td { padding: 4px 0; border-top: 1px solid var(--line); vertical-align: top; }
  .cat { color: var(--muted); text-transform: uppercase; font-size: 11px; width: 90px; }
  .price { text-align: right; white-space: nowrap; padding-left: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }
  a { color: var(--accent); }
  .muted { color: var(--muted); }
  .ok { color: var(--ok); margin: 8px 0 0; font-size: 12px; }
  .age { color: var(--muted); margin: 6px 0 0; font-size: 12px; }
  .issues { margin: 6px 0 0; padding-left: 18px; font-size: 12px; color: var(--muted); }
`;

export const CARD_SCRIPT = String.raw`
var PCBuildSageCard = (function (document) {
"use strict";
var DAY_MS = 86400000;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function money(n, currency) {
  if (typeof n !== "number" || !isFinite(n)) return "price unknown";
  var code = String(currency || "INR").toUpperCase();
  try {
    var zero = code === "INR";
    return new Intl.NumberFormat(code === "INR" ? "en-IN" : undefined, {
      style: "currency", currency: code,
      minimumFractionDigits: zero ? 0 : 2, maximumFractionDigits: zero ? 0 : 2
    }).format(n);
  } catch (e) {
    return code + " " + String(n);
  }
}

function oldestObservedAt(components) {
  var oldest = 0;
  var found = false;
  for (var i = 0; i < (components || []).length; i++) {
    var c = components[i] || {};
    if (typeof c.price !== "number" || typeof c.observed_at !== "string") continue;
    var t = Date.parse(c.observed_at);
    if (isNaN(t)) continue;
    if (!found || t < oldest) { oldest = t; found = true; }
  }
  return found ? oldest : 0;
}

function priceAgeLabel(components, now) {
  var then = oldestObservedAt(components);
  if (!then) return "";
  var days = Math.floor(((now == null ? Date.now() : now) - then) / DAY_MS);
  if (days < 0) days = 0;
  if (days === 0) return "prices checked today";
  if (days === 1) return "prices checked 1 day ago";
  return "prices checked " + days + " days ago";
}

function cardLabel(card, index) {
  if (card && typeof card.label === "string" && card.label) return card.label;
  return "Build " + (index + 1);
}

function tabNames(cards) {
  var seen = {};
  return cards.map(function (card, i) {
    var base = cardLabel(card, i);
    seen[base] = (seen[base] || 0) + 1;
    return seen[base] > 1 ? base + " \u00B7 " + seen[base] : base;
  });
}

function componentRows(components) {
  return (components || []).map(function (raw) {
    var c = raw || {};
    var price = c.included ? "included" : c.url
      ? '<a href="#" data-url="' + esc(c.url) + '">' + esc(money(c.price, c.currency)) + "</a>"
      : esc(money(c.price, c.currency));
    return '<tr><td class="cat">' + esc(c.category) + "</td><td>" + esc(c.name) +
      (c.retailer ? ' <span class="muted">\u00B7 ' + esc(c.retailer) + "</span>" : "") +
      '</td><td class="price">' + price + "</td></tr>";
  }).join("");
}

function buildSection(card, index, hideLabel, now) {
  var s = (card && card.snapshot) || {};
  var v = s.validation_summary;
  var checks = v ? v.passed + " checks passed" +
    (v.unverified ? ", " + v.unverified + " unverified" : "") +
    (v.skipped ? ", " + v.skipped + " skipped" : "") : "";
  var notes = ((v && v.issues) || []).map(function (issue) {
    return "<li>" + esc(issue) + "</li>";
  }).join("");
  var age = priceAgeLabel(s.components || [], now);
  return "<section>" +
    '<header>' +
    (hideLabel ? "" : "<h2>" + esc(card && card.label) + "</h2>") +
    '<span class="total">' + (s.total == null ? "total incomplete" : esc(money(s.total, s.currency))) + "</span>" +
    "</header>" +
    (card && card.notes ? '<p class="muted">' + esc(card.notes) + "</p>" : "") +
    "<table>" + componentRows(s.components) + "</table>" +
    (checks ? '<p class="ok">' + esc(checks) + "</p>" : "") +
    (age ? '<p class="age">' + esc(age) + "</p>" : "") +
    (notes ? '<ul class="issues">' + notes + "</ul>" : "") +
    "</section>";
}

function renderInto(root, state, now) {
  var cards = state.cards;
  if (!Array.isArray(cards) || cards.length === 0) {
    root.innerHTML = '<p class="muted">No build to show.</p>';
    return;
  }
  if (!(state.selected >= 0 && state.selected < cards.length)) state.selected = 0;
  var tabs = "";
  if (cards.length > 1) {
    var names = tabNames(cards);
    tabs = '<div class="tabs" role="tablist" aria-label="Builds">' + cards.map(function (card, i) {
      return '<button type="button" role="tab" class="tab" data-tab="' + i + '" aria-selected="' +
        (i === state.selected ? "true" : "false") + '">' + esc(names[i]) + "</button>";
    }).join("") + "</div>";
  }
  root.innerHTML = tabs + buildSection(cards[state.selected], state.selected, cards.length > 1, now);
}

function asElement(node, root) {
  while (node && node !== root) {
    if (node.nodeType === 1) return node;
    node = node.parentNode;
  }
  return null;
}

function mount(root, deps) {
  var openLink = deps.openLink;
  var state = { cards: [], selected: 0 };
  root.addEventListener("click", function (event) {
    var el = asElement(event.target, root);
    if (!el) return;
    var tab = el.closest("[data-tab]");
    if (tab && root.contains(tab)) {
      var next = parseInt(tab.getAttribute("data-tab"), 10);
      if (next >= 0 && next < state.cards.length) {
        state.selected = next;
        renderInto(root, state);
      }
      return;
    }
    var link = el.closest("a[data-url]");
    if (link) {
      event.preventDefault();
      openLink(link.getAttribute("data-url"));
    }
  });
  return {
    onToolResult: function (result) {
      var cards = result && result.structuredContent ? result.structuredContent.cards : undefined;
      state.cards = cards;
      if (!Array.isArray(cards) || state.selected >= cards.length) state.selected = 0;
      renderInto(root, state);
    },
    setTheme: function (theme) {
      if (theme !== "light" && theme !== "dark") return;
      document.documentElement.setAttribute("data-theme", theme);
    }
  };
}

return { esc: esc, money: money, priceAgeLabel: priceAgeLabel, renderInto: renderInto, mount: mount };
})(document);
`;

export const CARD_BOOT_SCRIPT = String.raw`
var App = __extApps.App;
var app = new App({ name: "PCBuildSage build card", version: "0.1.0" }, {}, { autoResize: true });
var view = PCBuildSageCard.mount(document.getElementById("root"), { openLink: function (url) { app.openLink({ url: url }); } });
app.ontoolresult = function (result) { view.onToolResult(result); };
var hostTheme = null;
app.onhostcontextchanged = function (ctx) {
  if (ctx && (ctx.theme === "light" || ctx.theme === "dark")) {
    hostTheme = ctx.theme;
    view.setTheme(ctx.theme);
  }
};
function prefersDark() {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch (e) {
    return false;
  }
}
view.setTheme(prefersDark() ? "dark" : "light");
try {
  var mq = window.matchMedia("(prefers-color-scheme: dark)");
  var onSchemeChange = function (e) { if (!hostTheme) view.setTheme(e.matches ? "dark" : "light"); };
  if (mq.addEventListener) mq.addEventListener("change", onSchemeChange);
  else if (mq.addListener) mq.addListener(onSchemeChange);
} catch (e) {}
await app.connect();
try {
  var hostCtx = app.getHostContext ? app.getHostContext() : null;
  if (hostCtx && (hostCtx.theme === "light" || hostCtx.theme === "dark")) {
    hostTheme = hostCtx.theme;
    view.setTheme(hostCtx.theme);
  }
} catch (e) {}
`;

/** The view API the CARD_SCRIPT exposes (for tests executing the script). */
export interface McpCardView {
  esc(value: unknown): string;
  money(value: unknown, currency: unknown): string;
  priceAgeLabel(
    components: Array<{ price?: unknown; observed_at?: unknown }>,
    now?: number
  ): string;
  renderInto(
    root: Element,
    state: { cards: unknown; selected: number },
    now?: number
  ): void;
  mount(
    root: Element,
    deps: { openLink(url: string): void }
  ): {
    onToolResult(result: unknown): void;
    setTheme(theme: string): void;
  };
}
