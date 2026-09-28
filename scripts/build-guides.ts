/**
 * Builds static budget build-guide pages for GitHub Pages from the real catalog.
 *
 * Zero LLM calls, zero network: per-tier part plan + createValidateBuildTool
 * + validate_build, exactly like scripts/build-sample-fixture.ts. For each
 * budget tier it validates combinations of the cheapest in-stock candidates
 * and keeps the valid, fully-priced, blocking-issue-free build that fits the
 * budget with the fewest unverified specs (needs_research/needs_verification),
 * then the lowest total. A budget with no such build is SKIPPED (logged,
 * exit 0, no page published). Nothing here is ever called "best".
 *
 *   npx tsx scripts/build-guides.ts [--db <path>] [--out <dir>]
 *
 * DB resolution: --db, then PCBUILDSAGE_DB_PATH, then data/products.db.
 * Output: <out>/index.html, <out>/gaming-<res>-under-<budget>.html per
 * published tier, and <out>/sitemap.xml for the Pages site. `site/` is a
 * gitignored build artifact produced locally and in CI (see
 * .github/workflows/refresh-catalog.yml); it is never committed.
 *
 * PREFILL-URL CONTRACT (for M2/G1 to honor; NOT implemented here, src/
 * is untouched): each guide ends with a "Customise this build" link of the
 * form `<DEMO_URL>?prompt=<encodeURIComponent(request)>`, where `request`
 * is a plain-English build request naming the budget, resolution, and picked
 * parts. The demo app SHOULD read the `prompt` query param on load and
 * prefill the chat/compose box with it. If the app later adopts a different
 * param name, only customiseUrl() below needs to change.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatPrice } from "../src/lib/format";
import { SqliteCatalogRepository } from "../src/lib/catalog/sqlite-repository";
import type { CatalogScope, SearchProductsInput } from "../src/lib/catalog/repository";
import type { BuildSnapshot } from "../src/lib/catalog/build-snapshot";
import type { ValidationResult } from "../src/lib/rules-engine";
import { createValidateBuildTool } from "../src/lib/tools/validate-build";

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

export interface TierPlan {
  budget: number;
  resolution: "1080p" | "1440p";
  /** Per-category catalog search filters for this tier; cheapest in-stock wins. */
  plan: Record<GuideCategory, SearchProductsInput>;
}

/**
 * Tier plan: one compatible AM4/DDR4/B550 backbone for every tier (so
 * validation has a chance everywhere), with the CPU/GPU search terms and
 * PSU/storage minimums stepping up with the budget. Terms are deliberately
 * model-family specific (not exact SKUs) so a re-scrape still matches.
 */
function tierPlan(budget: number, resolution: "1080p" | "1440p"): TierPlan["plan"] {
  const cpuTerm =
    budget <= 30000 ? "Ryzen 3"
    : budget <= 40000 ? "Ryzen 5 5500"
    : budget <= 60000 ? "Ryzen 5 5600"
    : budget <= 80000 ? "Ryzen 7 5700"
    : "Ryzen 7 5800";
  const gpuTerm =
    budget <= 30000 ? "RX 6400"
    : budget <= 40000 ? "RTX 3050"
    : budget <= 50000 ? "RX 6600"
    : budget <= 60000 ? "RTX 4060"
    : budget <= 70000 ? (resolution === "1440p" ? "RTX 4060 Ti" : "RTX 4060")
    : budget <= 80000 ? "RTX 5060"
    : budget <= 90000 ? "RTX 5060 Ti"
    : "RTX 5070";
  return {
    cpu: { term: cpuTerm },
    gpu: { term: gpuTerm },
    motherboard: { term: "B550" },
    ram: { ddr: "DDR4", min_capacity_gb: 16, modules: 2 },
    storage: { interface: "nvme", min_capacity_gb: budget <= 40000 ? 500 : 1000 },
    psu: { min_wattage: budget <= 40000 ? 450 : budget <= 60000 ? 550 : 650, term: "Bronze" },
    case: { term: "ATX" },
    cooler: { socket: "AM4" }
  };
}

export const BUDGET_TIERS: TierPlan[] = [
  ...[30000, 40000, 50000, 60000, 70000, 80000, 90000, 100000].map((budget) => ({
    budget,
    resolution: "1080p" as const,
    plan: tierPlan(budget, "1080p")
  })),
  ...[70000, 80000, 90000, 100000].map((budget) => ({
    budget,
    resolution: "1440p" as const,
    plan: tierPlan(budget, "1440p")
  }))
];

export const CANDIDATES_PER_CATEGORY = 3;
export const MAX_COMBOS = 3000;

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

async function inStockCandidates(
  repo: SqliteCatalogRepository,
  scope: CatalogScope,
  category: GuideCategory,
  filters: SearchProductsInput
): Promise<{ candidates: Candidate[]; fallback: boolean }> {
  const search = async (input: SearchProductsInput) =>
    repo.searchProducts(
      { ...input, category, inStockOnly: true, limit: CANDIDATES_PER_CATEGORY, sort_by: "price", order: "asc" },
      scope
    );
  let result = await search(filters);
  let fallback = false;
  if (result.results.length === 0) {
    // Filters too narrow for this scrape: fall back to cheapest in-stock in
    // the category and let validate_build decide compatibility.
    result = await search({});
    fallback = result.results.length > 0;
  }
  return {
    candidates: result.results.map((product) => ({
      id: product.id,
      name: product.name,
      price: product.price
    })),
    fallback
  };
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
      const reason = rank
        ? `Cheapest in-stock ${escapeHtml(rank.term)} in this tier (#${rank.rank} of ${rank.of}); compatibility checks passed (${passed}/${totalChecks}).`
        : `Compatibility checks passed (${passed}/${totalChecks}).`;
      const price = component.price === null ? "—" : escapeHtml(formatPrice(component.price, snapshot.currency));
      const name = escapeHtml(component.name);
      const buy = component.url
        ? `<a href="${escapeHtml(component.url)}">Buy</a>`
        : "—";
      return `      <tr><td>${escapeHtml(String(component.category))}</td><td>${name}</td><td>${price}</td><td>${escapeHtml(component.retailer ?? "")}</td><td>${buy}</td><td>${reason}</td></tr>`;
    })
    .join("\n");
  const partsSummary = snapshot.components.map((c) => `${c.category}: ${c.name}`).join("; ");
  const customise = customiseUrl(tier, partsSummary);
  const total = snapshot.total === null ? "—" : escapeHtml(formatPrice(snapshot.total, snapshot.currency));
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
  const urls = ["", ...published.map((guide) => `${guide.slug}.html`)]
    .map((page) => `  <url><loc>${PAGES_BASE_URL}${page}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

export async function runBuildGuides(
  args: string[] = process.argv.slice(2),
  deps: { repo?: SqliteCatalogRepository; outDir?: string; now?: Date } = {}
): Promise<{ exitCode: number; published: PublishedGuide[]; skipped: string[] }> {
  const dbPath = resolveDbPath(args);
  const outDir = deps.outDir ?? resolveOutDir(args);
  const generatedAt = (deps.now ?? new Date()).toISOString();
  const repo = deps.repo ?? new SqliteCatalogRepository(dbPath);
  const published: PublishedGuide[] = [];
  const skipped: string[] = [];
  try {
    const scope = await resolveScope(repo, repo.getDatabase() as never);
    const tool = createValidateBuildTool(scope, repo);
    const context = { toolCallId: "build-guides", messages: [] } as unknown as Parameters<
      NonNullable<typeof tool.execute>
    >[1];

    for (const tier of BUDGET_TIERS) {
      const label = guideSlug(tier);
      const perCategory: Candidate[][] = [];
      const rankByCategory = new Map<string, { rank: number; of: number; term: string }>();
      const fallbacks: GuideCategory[] = [];
      let missing: GuideCategory | null = null;
      for (const category of CATEGORIES) {
        const { candidates, fallback } = await inStockCandidates(repo, scope, category, tier.plan[category]);
        if (candidates.length === 0) {
          missing = category;
          break;
        }
        if (fallback) fallbacks.push(category);
        perCategory.push(candidates);
        const term = fallback
          ? `cheapest in-stock ${category}`
          : describeFilters(category, tier.plan[category]);
        // Rank each candidate within its tier list (cheapest-first search order).
        for (const [index, candidate] of candidates.entries()) {
          rankByCategory.set(`${category}:${candidate.id}`, {
            rank: index + 1,
            of: candidates.length,
            term: fallback ? `${term} (term fallback: cheapest in-stock ${category})` : term
          });
        }
      }
      if (missing) {
        skipped.push(`${label} (no in-stock candidates for ${missing})`);
        continue;
      }

      const valid: Array<{
        parts: Record<string, { product_id: string }>;
        validation: ValidationResult;
        snapshot: BuildSnapshot;
      }> = [];
      for (const combo of combos(perCategory)) {
        const parts: Record<string, { product_id: string }> = {};
        CATEGORIES.forEach((category, index) => {
          parts[category] = { product_id: combo[index].id };
        });
        const output = (await tool.execute!({ builds: [{ label, parts }] }, context)) as unknown as ToolOutput;
        const entry = output.builds?.[label];
        const snapshot = entry?.snapshot;
        if (!entry || !snapshot || !entry.valid || !snapshot.is_complete || typeof snapshot.total !== "number") continue;
        if (entry.issues.some((issue) => issue.severity === "blocking")) continue;
        if (snapshot.total > tier.budget) continue;
        valid.push({ parts, validation: entry, snapshot });
      }

      const picked = pickBuildForBudget(
        valid.map((v) => ({
          value: v,
          total: v.snapshot.total,
          unverified: v.validation.issues.filter(
            (issue) => issue.severity === "needs_research" || issue.severity === "needs_verification"
          ).length
        })),
        tier.budget
      );
      if (!picked) {
        skipped.push(`${label} (no valid, fully-priced, blocking-issue-free build within budget)`);
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

    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "index.html"), renderIndex(published, generatedAt));
    writeFileSync(path.join(outDir, "sitemap.xml"), renderSitemap(published));
    for (const skip of skipped) console.log(`[build-guides] skipped ${skip}.`);
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
