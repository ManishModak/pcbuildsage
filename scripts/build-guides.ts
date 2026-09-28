/**
 * Builds static budget build-guide pages for GitHub Pages from the real catalog.
 *
 * Zero LLM calls, zero network: per-tier part plan + createValidateBuildTool
 * + validate_build, exactly like scripts/build-sample-fixture.ts. For each
 * budget tier it takes the cheapest in-stock candidates for every part but
 * the GPU, spends what's left on the strongest GPU class that fits
 * (GPU_LADDER), validates the in-budget combinations, and keeps the valid,
 * fully-priced, blocking-issue-free build with the fewest unverified specs
 * (needs_research/needs_verification), then the lowest total. A budget with no such build is SKIPPED (logged, no
 * page published). If EVERY tier is skipped the script exits 1 and writes
 * nothing, so the Pages deploy never runs and the last good site stays up.
 * Nothing here is ever called "best".
 *
 *   npx tsx scripts/build-guides.ts [--db <path>] [--out <dir>]
 *
 * DB resolution: --db, then PCBUILDSAGE_DB_PATH, then data/products.db.
 * Output: <out>/index.html, <out>/gaming-<res>-under-<budget>.html per
 * published tier, <out>/help/api-key/index.html (static mirror of the in-app
 * /help/api-key page, rendered from G3's src/content/api-key-help.ts), and
 * <out>/sitemap.xml for the Pages site. `site/` is a
 * gitignored build artifact produced locally and in CI (see
 * .github/workflows/refresh-catalog.yml); it is never committed.
 *
 * PREFILL-URL CONTRACT: each guide ends with a "Customise this build" link
 * of the form `<DEMO_URL>?prompt=<encodeURIComponent(request)>`, where
 * `request` is a plain-English build request naming the budget, resolution,
 * and picked parts. The demo app reads it into a new chat's composer (see
 * src/features/chat/prompt-prefill.ts, which caps its length).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatPrice } from "../src/lib/format";
import { SqliteCatalogRepository } from "../src/lib/catalog/sqlite-repository";
import type { CatalogScope, SearchProductsInput } from "../src/lib/catalog/repository";
import type { BuildSnapshot } from "../src/lib/catalog/build-snapshot";
import type { ValidationResult } from "../src/lib/rules-engine";
import { createValidateBuildTool } from "../src/lib/tools/validate-build";
import {
  API_KEY_FAQS,
  API_KEY_FACTS,
  API_KEY_GUIDES,
  FREE_LIMIT_COPY,
  KEY_REJECTED_COPY
} from "../src/content/api-key-help";

export const DEMO_URL = "https://pcbuildsage.onrender.com";
export const PAGES_BASE_URL = "https://manishmodak.github.io/pcbuildsage/";

export const CATEGORIES = [
  "cpu",
  "gpu",
  "motherboard",
  "ram",
  "storage",
  "psu",
  "case",
  "cooler"
] as const;
export type GuideCategory = (typeof CATEGORIES)[number];

type Resolution = "1080p" | "1440p";
type FixedCategory = Exclude<GuideCategory, "gpu">;

export interface TierPlan {
  budget: number;
  resolution: Resolution;
  /** Search filters for every part except the GPU; cheapest in-stock wins. */
  plan: Record<FixedCategory, SearchProductsInput>;
  /** GPU classes this tier may use, weakest first; the strongest that fits wins. */
  gpuClasses: readonly string[];
}

/**
 * GPU classes (search terms), roughly weakest to strongest. Current families
 * only: last-gen cards still listed at launch-era prices (RTX 4060, 3060) are
 * left out. The order is an approximation of relative gaming performance.
 */
export const GPU_LADDER = [
  "RTX 3050",
  "RTX 5050",
  "RX 7600",
  "RTX 5060",
  "RX 9060 XT",
  "RTX 5060 Ti",
  "RX 7700 XT",
  "RTX 5070",
  "RX 9070",
  "RX 9070 XT",
  "RTX 5070 Ti"
] as const;

/** Weakest GPU class a page for this resolution may recommend. */
export const MIN_GPU_CLASS: Record<Resolution, (typeof GPU_LADDER)[number]> = {
  "1080p": "RTX 3050",
  "1440p": "RTX 5060 Ti"
};

/**
 * Tier plan: one compatible AM4/DDR4/B550 backbone for every tier (so
 * validation has a chance everywhere), with the CPU and the storage/PSU
 * minimums stepping up with the budget. Whatever is left of the budget buys
 * the strongest GPU class that fits (see runBuildGuides), so pages track real
 * prices instead of a fixed GPU per budget going stale. Terms are
 * model-family specific (not exact SKUs) so a re-scrape still matches.
 *
 * 1440p is GPU-bound, so its tiers take the CPU one step down to leave more
 * for the GPU, and must reach at least MIN_GPU_CLASS["1440p"]. RAM stays 16GB
 * DDR4 (2 modules) everywhere: more capacity doesn't help 1440p specifically.
 */
const CPU_LADDER = ["Ryzen 5 5500", "Ryzen 5 5600"];

export function tierPlan(budget: number, resolution: Resolution): TierPlan["plan"] {
  const step = (budget <= 70000 ? 0 : 1) - (resolution === "1440p" ? 1 : 0);
  return {
    cpu: { term: CPU_LADDER[Math.max(0, step)] },
    motherboard: { term: "B550" },
    ram: { ddr: "DDR4", min_capacity_gb: 16, modules: 2 },
    storage: { interface: "nvme", min_capacity_gb: budget < 80000 ? 500 : 1000 },
    psu: { min_wattage: budget < 90000 ? 550 : 650, term: "Bronze" },
    case: { term: "ATX" },
    cooler: { socket: "AM4" }
  };
}

function tier(budget: number, resolution: Resolution): TierPlan {
  return {
    budget,
    resolution,
    plan: tierPlan(budget, resolution),
    gpuClasses: GPU_LADDER.slice(GPU_LADDER.indexOf(MIN_GPU_CLASS[resolution]))
  };
}

export const BUDGET_TIERS: TierPlan[] = [
  ...[30000, 40000, 50000, 60000, 70000, 80000, 90000, 100000].map((budget) => tier(budget, "1080p")),
  ...[70000, 80000, 90000, 100000].map((budget) => tier(budget, "1440p"))
];

/**
 * Cheapest in-stock candidates tried per category. The full combination
 * space (3 * 2^7 = 384) fits under MAX_COMBOS, so every candidate is tried;
 * combinations over budget are dropped by price before validation.
 */
export const CANDIDATES_PER_CATEGORY: Record<GuideCategory, number> = {
  cpu: 2,
  gpu: 3,
  motherboard: 2,
  ram: 2,
  storage: 2,
  psu: 2,
  case: 2,
  cooler: 2
};
export const MAX_COMBOS = 3000;
/** GPU classes tried per tier (strongest fitting first) before skipping it. */
export const MAX_GPU_CLASS_TRIES = 2;

/**
 * The CPU term defines the tier: if it finds nothing the tier is skipped
 * rather than falling back to the cheapest in-stock CPU. GPUs never fall back
 * either (they come from GPU_LADDER). Commodity categories may fall back to
 * the cheapest in-stock part.
 */
export const NO_FALLBACK_CATEGORIES: readonly GuideCategory[] = ["cpu", "gpu"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Formats an ISO timestamp in IST, e.g. "28 Sep 2026, 2:24 pm IST". */
export function formatIst(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const ist = new Date(time + IST_OFFSET_MS);
  const hours = ist.getUTCHours();
  const minutes = String(ist.getUTCMinutes()).padStart(2, "0");
  return (
    `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]} ${ist.getUTCFullYear()}, ` +
    `${hours % 12 || 12}:${minutes} ${hours < 12 ? "am" : "pm"} IST`
  );
}

export function guideSlug(tier: Pick<TierPlan, "budget" | "resolution">): string {
  return `gaming-${tier.resolution}-under-${tier.budget}`;
}

export function guideTitle(tier: Pick<TierPlan, "budget" | "resolution">): string {
  return `Gaming PC under ₹${tier.budget.toLocaleString("en-IN")} (${tier.resolution})`;
}

/** Prefill-URL contract: demo URL with the customise request in `?prompt=`. */
export function customiseRequest(
  tier: Pick<TierPlan, "budget" | "resolution">,
  partsSummary: string
): string {
  return (
    `Customise this ${tier.resolution} gaming build under Rs. ${tier.budget}: ${partsSummary}. ` +
    `Keep every part in stock at an Indian retailer with exact prices and buy links, ` +
    `and re-validate compatibility.`
  );
}

export function customiseUrl(
  tier: Pick<TierPlan, "budget" | "resolution">,
  partsSummary: string
): string {
  return `${DEMO_URL}?prompt=${encodeURIComponent(customiseRequest(tier, partsSummary))}`;
}

/** Human-readable descriptor for a tier's category filters (used in per-pick reasons). */
export function describeFilters(category: GuideCategory, filters: SearchProductsInput): string {
  if (typeof filters.term === "string" && filters.term) return filters.term;
  const bits: string[] = [];
  if (typeof filters.socket === "string" && filters.socket) bits.push(`${filters.socket} socket`);
  if (typeof filters.ddr === "string" && filters.ddr) bits.push(String(filters.ddr));
  if (filters.min_capacity_gb !== undefined) bits.push(`${filters.min_capacity_gb}GB+`);
  if (typeof filters.interface === "string" && filters.interface) bits.push(String(filters.interface).toUpperCase());
  if (filters.min_wattage !== undefined) bits.push(`${filters.min_wattage}W+`);
  if (bits.length > 0) return `${bits.join(" ")} ${category}`;
  return String(category);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Exact total: sum of priced components; null when any part is unpriced. */
export function guideTotal(
  components: Array<{ price?: number | null }>
): number | null {
  if (components.length === 0) return null;
  let total = 0;
  for (const component of components) {
    if (typeof component.price !== "number") return null;
    total += component.price;
  }
  return total;
}

export interface PickableBuild {
  total: number | null;
  unverified: number;
}

function pickScore(build: { total: number; unverified: number }): number {
  return build.unverified * 1_000_000 + build.total;
}

/**
 * Fixture picker, plus the budget ceiling: the valid build with total within
 * budget, fewest unverified specs, then lowest total. Null = skip the budget.
 */
export function pickBuildForBudget<T extends PickableBuild>(
  candidates: T[],
  budget: number
): T | null {
  let picked: T | null = null;
  let pickedScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate.total === null || candidate.total > budget) continue;
    const score = pickScore({ total: candidate.total, unverified: candidate.unverified });
    if (score < pickedScore) {
      picked = candidate;
      pickedScore = score;
    }
  }
  return picked;
}

function flagValue(name: string, args: string[]): string | undefined {
  const index = args.indexOf(name);
  return index !== -1 ? args[index + 1] : undefined;
}

export function resolveDbPath(args: string[] = process.argv.slice(2)): string {
  const candidates = [
    flagValue("--db", args),
    process.env.PCBUILDSAGE_DB_PATH,
    path.join(process.cwd(), "data", "products.db")
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return path.resolve(candidate);
  }
  throw new Error(
    `No catalog database found. Tried: ${candidates.join(", ")}. Pass --db <path>.`
  );
}

export function resolveOutDir(args: string[] = process.argv.slice(2)): string {
  return path.resolve(flagValue("--out", args) ?? path.join(process.cwd(), "site"));
}

type Candidate = { id: string; name: string; price: number | null };

const toCandidate = (product: Candidate): Candidate => ({
  id: product.id,
  name: product.name,
  price: product.price
});

/** Weakest GPU class a tier may publish: its minimum, and above `above` (a ladder index) when set. */
function weakestAllowed(tier: TierPlan, above: number | undefined): string {
  const floor = Math.max(GPU_LADDER.indexOf(tier.gpuClasses[0] as (typeof GPU_LADDER)[number]), (above ?? -1) + 1);
  return GPU_LADDER[Math.min(floor, GPU_LADDER.length - 1)];
}

const FIXED_CATEGORIES = CATEGORIES.filter((category): category is FixedCategory => category !== "gpu");

async function inStockCandidates(
  repo: SqliteCatalogRepository,
  scope: CatalogScope,
  category: GuideCategory,
  filters: SearchProductsInput
): Promise<{ candidates: Candidate[]; fallback: boolean }> {
  const search = async (input: SearchProductsInput) =>
    repo.searchProducts(
      { ...input, category, inStockOnly: true, limit: CANDIDATES_PER_CATEGORY[category], sort_by: "price", order: "asc" },
      scope
    );
  let result = await search(filters);
  let fallback = false;
  if (result.results.length === 0 && !NO_FALLBACK_CATEGORIES.includes(category)) {
    // Commodity filters too narrow for this scrape: fall back to cheapest
    // in-stock in the category and let validate_build decide compatibility.
    result = await search({});
    fallback = result.results.length > 0;
  }
  return { candidates: result.results.map(toCandidate), fallback };
}

async function resolveScope(
  repo: SqliteCatalogRepository,
  db: { prepare: (sql: string) => { all: () => Array<{ country_code: string; currency: string; count: number }> } }
): Promise<CatalogScope> {
  const markets = db
    .prepare(
      `SELECT country_code, currency, COUNT(*) AS count FROM products
       WHERE in_stock = 1 GROUP BY country_code, currency ORDER BY count DESC`
    )
    .all();
  for (const market of markets) {
    const scope: CatalogScope = { countryCode: market.country_code, currency: market.currency };
    const coverage = await Promise.all(
      CATEGORIES.map((category) => repo.getCategoryBaseline(category, scope))
    );
    if (coverage.every((baseline) => baseline.in_stock_total > 0)) return scope;
  }
  throw new Error("No market has in-stock listings in every build category.");
}

/** Newest scrape time among the scope's in-stock listings, or null. */
function latestScrape(db: Database.Database, scope: CatalogScope): string | null {
  const row = db
    .prepare(
      `SELECT MAX(last_scraped) AS latest FROM products
       WHERE in_stock = 1 AND country_code = ? AND currency = ?`
    )
    .get(scope.countryCode, scope.currency) as { latest: string | null } | undefined;
  return row?.latest ?? null;
}

function* combos(lists: Candidate[][]): Generator<Candidate[]> {
  const total = lists.reduce((product, list) => product * list.length, 1);
  if (total === 0) return;
  const indices = lists.map(() => 0);
  let emitted = 0;
  while (emitted < Math.min(total, MAX_COMBOS)) {
    yield indices.map((index, list) => lists[list][index]);
    emitted += 1;
    for (let list = lists.length - 1; list >= 0; list--) {
      indices[list] += 1;
      if (indices[list] < lists[list].length) break;
      indices[list] = 0;
      if (list === 0) return;
    }
  }
}

type ToolOutput = Record<string, ValidationResult & { snapshot?: BuildSnapshot }> & {
  builds?: Record<string, ValidationResult & { snapshot?: BuildSnapshot }>;
};

export interface PublishedGuide {
  tier: Pick<TierPlan, "budget" | "resolution">;
  slug: string;
  total: number;
  currency: string;
  componentCount: number;
  partsSummary: string;
}

/** Public-page wording for an unverified check: part names, not internal ids or engine text. */
function plainUnverified(issue: ValidationResult["issues"][number], snapshot: BuildSnapshot): string {
  const names = issue.components
    .map((id) => snapshot.components.find((c) => c.product_id === id)?.name)
    .filter((name): name is string => Boolean(name));
  const parts = names.length ? ` (${names.join(", ")})` : "";
  if (issue.rule === "clearance") return `that the graphics card and cooler fit inside the case${parts}`;
  if (issue.rule === "storage") return `that the motherboard has a free slot for the storage drive${parts}`;
  if (issue.rule === "spec_resolution") return `specs we could not source for${parts || " some parts"}`;
  return issue.detail;
}

/** formatPrice without a trailing ".00": guide prices are whole rupees. */
function wholePrice(amount: number, currency: string): string {
  return formatPrice(amount, currency).replace(/\.00$/, "");
}

function renderGuidePage(args: {
  tier: Pick<TierPlan, "budget" | "resolution">;
  snapshot: BuildSnapshot;
  validation: ValidationResult;
  generatedAt: string;
  rankByCategory: Map<string, { rank: number; of: number; term: string }>;
}): string {
  const { tier, snapshot, validation, generatedAt, rankByCategory } = args;
  const title = guideTitle(tier);
  const passed = validation.summary?.passed ?? validation.checks.filter((c) => c.status === "passed").length;
  const totalChecks = validation.checks.length;
  const rows = snapshot.components
    .map((component) => {
      const rank = rankByCategory.get(String(component.category));
      // The case search term is a form factor ("ATX" also matches M-ATX), so name the category instead.
      const termLabel = rank && component.category === "case" ? "case" : rank?.term;
      const reason = rank
        ? `Cheapest in-stock ${escapeHtml(termLabel ?? "")} in this tier (#${rank.rank} of ${rank.of}).`
        : "";
      const price = component.price === null ? "—" : escapeHtml(wholePrice(component.price, snapshot.currency));
      const name = escapeHtml(component.name);
      const buy = component.url
        ? `<a href="${escapeHtml(component.url)}">Buy</a>`
        : "—";
      return `      <tr><td>${escapeHtml(String(component.category))}</td><td>${name}</td><td>${price}</td><td>${escapeHtml(component.retailer ?? "")}</td><td>${buy}</td><td>${reason}</td></tr>`;
    })
    .join("\n");
  const partsSummary = snapshot.components.map((c) => `${c.category}: ${c.name}`).join("; ");
  const customise = customiseUrl(tier, partsSummary);
  const total = snapshot.total === null ? "—" : escapeHtml(wholePrice(snapshot.total, snapshot.currency));
  const unverified = validation.issues.filter(
    (issue) => issue.severity === "needs_verification" || issue.severity === "needs_research"
  );
  const checksLine =
    `Compatibility: ${passed} of ${totalChecks} checks passed by code.` +
    (unverified.length
      ? ` Not verified, please check before buying: ${[...new Set(unverified.map((issue) => plainUnverified(issue, snapshot)))].join("; ")}.`
      : "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — PCBuildSage</title>
<style>body{font-family:system-ui,sans-serif;max-width:72rem;margin:2rem auto;padding:0 1rem;line-height:1.5}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:.4rem .6rem;text-align:left;font-size:.9rem}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p><strong>Total: ${total}</strong> (budget ₹${tier.budget.toLocaleString("en-IN")}) · prices checked ${escapeHtml(generatedAt)}</p>
<p>${escapeHtml(checksLine)}</p>
<table>
<thead><tr><th>Part</th><th>Name</th><th>Price</th><th>Retailer</th><th>Buy</th><th>Why this pick</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p><a href="${escapeHtml(customise)}">Customise this build</a> — opens the PCBuildSage demo with this request prefilled.</p>
<p><a href="./">All guides</a></p>
</body>
</html>
`;
}

function renderIndex(published: PublishedGuide[], generatedAt: string): string {
  const items = published
    .map(
      (guide) =>
        `    <li><a href="./${guide.slug}.html">${escapeHtml(guideTitle(guide.tier))}</a> — ${escapeHtml(formatPrice(guide.total, guide.currency))} across ${guide.componentCount} parts</li>`
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Budget build guides — PCBuildSage</title>
</head>
<body>
<h1>Budget build guides</h1>
<p>Validated against in-stock Indian retailer listings · prices checked ${escapeHtml(generatedAt)}</p>
<ul>
${items}
</ul>
</body>
</html>
`;
}

function renderSitemap(published: PublishedGuide[]): string {
  const urls = ["", ...published.map((guide) => `${guide.slug}.html`), "help/api-key/"]
    .map((page) => `  <url><loc>${PAGES_BASE_URL}${page}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

/**
 * M2: static mirror of the in-app /help/api-key page, rendered from the SAME
 * content module G3 owns (src/content/api-key-help.ts) — no LLM calls, no
 * copy-paste drift. The challenger test asserts every guide title, fact
 * heading, FAQ question and error string from the module appears here.
 */
export function renderHelpPage(): string {
  const guides = API_KEY_GUIDES.map(
    (guide) => `<article>
<h2>${escapeHtml(guide.title)}</h2>
<ol>
${guide.steps
  .map(
    (step, index) =>
      `  <li>${escapeHtml(step.text)}${index === 0 ? ` <a href="${escapeHtml(guide.keyUrl)}">${escapeHtml(guide.keyUrlLabel)} ↗</a>` : ""}</li>`
  )
  .join("\n")}
</ol>
</article>`
  ).join("\n");
  const facts = API_KEY_FACTS.map(
    (fact) => `<article>
<h3>${escapeHtml(fact.heading)}</h3>
<p>${escapeHtml(fact.text)}</p>
</article>`
  ).join("\n");
  const faqs = API_KEY_FAQS.map(
    (faq) => `<article>
<h3>${escapeHtml(faq.question)}</h3>
<p>${escapeHtml(faq.answer)}</p>
</article>`
  ).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Get a free API key in 2 minutes — PCBuildSage Help</title>
<meta name="description" content="Free Gemini and OpenRouter API key setup for PCBuildSage: steps, costs, safety, and error help.">
</head>
<body>
<h1>Get a free API key in 2 minutes</h1>
<p>PCBuildSage chats through your own provider key. Pick one option below — both have a free tier.</p>
${guides}
<h2>Good to know</h2>
${facts}
<h2>If chat shows an error</h2>
<article>
<h3>Key rejected</h3>
<p>“${escapeHtml(KEY_REJECTED_COPY)}”</p>
</article>
<article>
<h3>Free limit reached</h3>
<p>“${escapeHtml(FREE_LIMIT_COPY)}”</p>
</article>
<h2>Questions</h2>
${faqs}
<p><a href="https://pcbuildsage.onrender.com/settings?tab=llm">Open Settings to paste your key →</a></p>
<p><a href="../">All guides</a></p>
</body>
</html>
`;
}

export async function runBuildGuides(
  args: string[] = process.argv.slice(2),
  deps: { repo?: SqliteCatalogRepository; outDir?: string; now?: Date } = {}
): Promise<{ exitCode: number; published: PublishedGuide[]; skipped: string[] }> {
  const dbPath = resolveDbPath(args);
  const outDir = deps.outDir ?? resolveOutDir(args);
  const repo = deps.repo ?? new SqliteCatalogRepository(dbPath);
  const published: PublishedGuide[] = [];
  const skipped: string[] = [];
  // GPU_LADDER index of each published 1080p page's GPU, by budget.
  const gpuClass1080 = new Map<number, number>();
  try {
    const scope = await resolveScope(repo, repo.getDatabase() as never);
    // "Prices checked" = when the catalog was scraped, not when this ran.
    const generatedAt = formatIst(
      latestScrape(repo.getDatabase(), scope) ?? (deps.now ?? new Date()).toISOString()
    );
    const tool = createValidateBuildTool(scope, repo);
    const context = { toolCallId: "build-guides", messages: [] } as unknown as Parameters<
      NonNullable<typeof tool.execute>
    >[1];

    // Validates every in-budget combination of the per-category candidate
    // lists (CATEGORIES order) and returns the picker's choice, or null.
    const pickValid = async (label: string, budget: number, lists: Candidate[][]) => {
      const valid: Array<{ validation: ValidationResult; snapshot: BuildSnapshot }> = [];
      for (const combo of combos(lists)) {
        // Cheap price check first: most combinations never need validating.
        const sum = guideTotal(combo);
        if (sum === null || sum > budget) continue;
        const parts: Record<string, { product_id: string }> = {};
        CATEGORIES.forEach((category, index) => {
          parts[category] = { product_id: combo[index].id };
        });
        const output = (await tool.execute!({ builds: [{ label, parts }] }, context)) as unknown as ToolOutput;
        const entry = output.builds?.[label];
        const snapshot = entry?.snapshot;
        if (!entry || !snapshot || !entry.valid || !snapshot.is_complete || typeof snapshot.total !== "number") continue;
        if (entry.issues.some((issue) => issue.severity === "blocking")) continue;
        if (snapshot.total > budget) continue;
        valid.push({ validation: entry, snapshot });
      }
      return pickBuildForBudget(
        valid.map((v) => ({
          value: v,
          total: v.snapshot.total,
          unverified: v.validation.issues.filter(
            (issue) => issue.severity === "needs_research" || issue.severity === "needs_verification"
          ).length
        })),
        budget
      );
    };

    for (const tier of BUDGET_TIERS) {
      const label = guideSlug(tier);
      const lists = new Map<GuideCategory, Candidate[]>();
      const rankByCategory = new Map<string, { rank: number; of: number; term: string }>();
      const addRanks = (category: GuideCategory, candidates: Candidate[], term: string) => {
        // Rank each candidate within its tier list (cheapest-first search order).
        for (const [index, candidate] of candidates.entries()) {
          rankByCategory.set(`${category}:${candidate.id}`, { rank: index + 1, of: candidates.length, term });
        }
      };
      const fallbacks: GuideCategory[] = [];
      let missing: FixedCategory | null = null;
      for (const category of FIXED_CATEGORIES) {
        const { candidates, fallback } = await inStockCandidates(repo, scope, category, tier.plan[category]);
        if (candidates.length === 0) {
          missing = category;
          break;
        }
        if (fallback) fallbacks.push(category);
        lists.set(category, candidates);
        const term = describeFilters(category, tier.plan[category]);
        addRanks(
          category,
          candidates,
          fallback ? `cheapest in-stock ${category} (term fallback: no ${term} in stock)` : term
        );
      }
      if (missing) {
        const reason = NO_FALLBACK_CATEGORIES.includes(missing)
          ? `no in-stock ${missing} matching "${describeFilters(missing, tier.plan[missing])}"`
          : `no in-stock candidates for ${missing}`;
        skipped.push(`${label} (${reason})`);
        continue;
      }

      // What the cheapest other parts leave buys the GPU: the strongest class
      // (from the top of the tier's ladder) with an in-stock card that fits.
      const restMin = [...lists.values()].reduce(
        (sum, candidates) => sum + Math.min(...candidates.map((c) => c.price ?? Number.POSITIVE_INFINITY)),
        0
      );
      const gpuBudget = tier.budget - restMin;
      // A 1440p page must beat the 1080p page's GPU at the same budget, or it
      // would just be that page with a weaker CPU.
      const above = tier.resolution === "1440p" ? gpuClass1080.get(tier.budget) : undefined;
      let picked: Awaited<ReturnType<typeof pickValid>> = null;
      let gpuClass = "";
      let tries = 0;
      for (const cls of [...tier.gpuClasses].reverse()) {
        if (gpuBudget <= 0 || tries >= MAX_GPU_CLASS_TRIES) break;
        if (above !== undefined && GPU_LADDER.indexOf(cls as (typeof GPU_LADDER)[number]) <= above) break;
        const gpus = (
          await repo.searchProducts(
            {
              term: cls,
              category: "gpu",
              price_max: gpuBudget,
              inStockOnly: true,
              limit: CANDIDATES_PER_CATEGORY.gpu,
              sort_by: "price",
              order: "asc"
            },
            scope
          )
        ).results.map(toCandidate);
        if (gpus.length === 0) continue;
        tries += 1;
        lists.set("gpu", gpus);
        picked = await pickValid(label, tier.budget, CATEGORIES.map((category) => lists.get(category)!));
        if (picked) {
          gpuClass = cls;
          addRanks("gpu", gpus, `${cls} (the strongest GPU class that fits the budget)`);
          break;
        }
      }
      if (!picked) {
        const reason =
          gpuBudget <= 0
            ? `the other parts alone cost ${formatPrice(restMin, scope.currency)}`
            : tries > 0
              ? "no valid, fully-priced, blocking-issue-free build within budget"
              : `no ${weakestAllowed(tier, above)}-or-better GPU fits the ${formatPrice(gpuBudget, scope.currency)} left after other parts` +
                (above !== undefined ? `; 1440p must beat the 1080p page's ${GPU_LADDER[above]}` : "");
        skipped.push(`${label} (${reason})`);
        continue;
      }

      // Challenger self-check: every product ID resolves + total equals sum of parts.
      const ids = picked.value.snapshot.components.map((c) => c.product_id).filter(Boolean) as string[];
      const resolved = await repo.searchProducts({ product_ids: ids, inStockOnly: false, limit: ids.length }, scope);
      const found = new Set(resolved.results.map((product) => product.id));
      const unresolved = ids.filter((id) => !found.has(id));
      if (unresolved.length > 0) {
        skipped.push(`${label} (catalog IDs no longer resolve: ${unresolved.join(", ")})`);
        continue;
      }
      const summed = guideTotal(picked.value.snapshot.components);
      if (summed === null || Math.abs(summed - (picked.value.snapshot.total ?? NaN)) > 0.005) {
        skipped.push(`${label} (total mismatch: snapshot ${picked.value.snapshot.total} vs sum ${summed})`);
        continue;
      }

      if (tier.resolution === "1080p") {
        gpuClass1080.set(tier.budget, GPU_LADDER.indexOf(gpuClass as (typeof GPU_LADDER)[number]));
      }

      const ranks = new Map<string, { rank: number; of: number; term: string }>();
      for (const component of picked.value.snapshot.components) {
        const key = `${component.category}:${component.product_id}`;
        const rank = rankByCategory.get(key);
        if (rank) ranks.set(String(component.category), rank);
      }
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        path.join(outDir, `${label}.html`),
        renderGuidePage({ tier, snapshot: picked.value.snapshot, validation: picked.value.validation, generatedAt, rankByCategory: ranks })
      );
      published.push({
        tier: { budget: tier.budget, resolution: tier.resolution },
        slug: label,
        total: picked.value.snapshot.total ?? 0,
        currency: picked.value.snapshot.currency,
        componentCount: picked.value.snapshot.component_count,
        partsSummary: picked.value.snapshot.components.map((c) => `${c.category}: ${c.name}`).join("; ")
      });
      console.log(
        `[build-guides] published ${label}: ${formatPrice(picked.value.snapshot.total, picked.value.snapshot.currency)}` +
          (fallbacks.length > 0 ? ` (term fallback: ${fallbacks.join(", ")})` : "") +
          "."
      );
    }

    for (const skip of skipped) console.log(`[build-guides] skipped ${skip}.`);
    if (published.length === 0) {
      // Fail so CI never deploys an empty site: Pages keeps the last good one.
      console.error("[build-guides] every tier was skipped; nothing published.");
      return { exitCode: 1, published, skipped };
    }

    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "index.html"), renderIndex(published, generatedAt));
    writeFileSync(path.join(outDir, "sitemap.xml"), renderSitemap(published));
    // M2: /help/api-key mirror (same G3 content module as the in-app page).
    const helpDir = path.join(outDir, "help", "api-key");
    mkdirSync(helpDir, { recursive: true });
    writeFileSync(path.join(helpDir, "index.html"), renderHelpPage());
    console.log(`[build-guides] done: ${published.length} published, ${skipped.length} skipped.`);
    return { exitCode: 0, published, skipped };
  } finally {
    if (!deps.repo) await repo.close?.();
  }
}

const isMain = Boolean(
  process.argv[1] &&
    (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
      process.argv[1].endsWith("build-guides.ts"))
);

if (isMain) {
  runBuildGuides(process.argv.slice(2))
    .then(({ exitCode }) => {
      process.exit(exitCode);
    })
    .catch((err) => {
      console.error("[build-guides] Uncaught error:", err);
      process.exit(1);
    });
}
