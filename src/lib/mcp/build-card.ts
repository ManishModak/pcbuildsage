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
 *
 * The card markup, styles and view logic live in ./card/view.ts, whose script
 * strings are also executed verbatim by the card's render tests.
 */
import fs from "node:fs";
import path from "node:path";
import { CARD_BOOT_SCRIPT, CARD_SCRIPT, CARD_STYLES } from "./card/view";

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

/** The card's HTML document, built once per process. */
export function buildCardHtml(): string {
  cachedHtml ??= `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${CARD_STYLES}</style></head><body><div id="root"><p class="muted">Loading build…</p></div><script type="module">${inlineAppBundle(fs.readFileSync(APP_BUNDLE_PATH, "utf8"))}\n${CARD_SCRIPT}\n${CARD_BOOT_SCRIPT}</script></body></html>`;
  return cachedHtml;
}
