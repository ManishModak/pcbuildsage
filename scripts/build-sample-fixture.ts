/**
 * Builds the static sample-conversation fixture for the hosted empty screen.
 *
 * Runs validate_build against the current local catalog only: no LLM call, no
 * network, no API key. Re-run whenever the catalog changes so the example
 * stays backed by real listings:
 *
 *   npx tsx scripts/build-sample-fixture.ts [--db <path>] [--out <path>]
 *
 * DB resolution: --db, then PCBUILDSAGE_DB_PATH, then data/products.db, then
 * data/products-sample.db. Scope resolution: the market (country/currency)
 * with in-stock listings in every build category.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { formatPrice } from "../src/lib/format";
import { SqliteCatalogRepository } from "../src/lib/catalog/sqlite-repository";
import type { CatalogScope } from "../src/lib/catalog/repository";
import type { BuildSnapshot } from "../src/lib/catalog/build-snapshot";
import type { ValidationResult } from "../src/lib/rules-engine";
import { createValidateBuildTool } from "../src/lib/tools/validate-build";

const CATEGORIES = [
  "cpu",
  "gpu",
  "motherboard",
  "ram",
  "storage",
  "psu",
  "case",
  "cooler"
] as const;

const CANDIDATES_PER_CATEGORY = 3;
const MAX_COMBOS = 200;
const LABEL = "Example 1440p Gaming";

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

function resolveDbPath(): string {
  const candidates = [
    flagValue("--db"),
    process.env.PCBUILDSAGE_DB_PATH,
    path.join(process.cwd(), "data", "products.db"),
    path.join(process.cwd(), "data", "products-sample.db")
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return path.resolve(candidate);
  }
  throw new Error(
    `No catalog database found. Tried: ${candidates.join(", ")}. Pass --db <path>.`
  );
}

function resolveOutPath(): string {
  return path.resolve(
    flagValue("--out") ?? path.join(process.cwd(), "data", "fixtures", "sample-conversation.json")
  );
}

type Candidate = { id: string; name: string; price: number | null };

async function inStockCandidates(
  repo: SqliteCatalogRepository,
  scope: CatalogScope,
  category: string
): Promise<Candidate[]> {
  const result = await repo.searchProducts(
    { category, inStockOnly: true, limit: CANDIDATES_PER_CATEGORY, sort_by: "price", order: "asc" },
    scope
  );
  return result.results.map((product) => ({
    id: product.id,
    name: product.name,
    price: product.price
  }));
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

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  const outPath = resolveOutPath();
  const repo = new SqliteCatalogRepository(dbPath);
  try {
    const scope = await resolveScope(repo, repo.getDatabase() as never);
    const perCategory = await Promise.all(
      CATEGORIES.map((category) => inStockCandidates(repo, scope, category))
    );
    const missing = CATEGORIES.filter((_, index) => perCategory[index].length === 0);
    if (missing.length > 0) {
      throw new Error(`No in-stock candidates for: ${missing.join(", ")} (${dbPath}).`);
    }

    const tool = createValidateBuildTool(scope, repo);
    const context = { toolCallId: "sample-fixture", messages: [] } as unknown as Parameters<
      NonNullable<typeof tool.execute>
    >[1];

    let picked: { parts: Record<string, { product_id: string }>; validation: ValidationResult; snapshot: BuildSnapshot } | null = null;
    let attempts = 0;
    for (const combo of combos(perCategory)) {
      attempts += 1;
      const parts: Record<string, { product_id: string }> = {};
      CATEGORIES.forEach((category, index) => {
        parts[category] = { product_id: combo[index].id };
      });
      const output = (await tool.execute!({ builds: [{ label: LABEL, parts }] }, context)) as unknown as ToolOutput;
      const entry = output.builds?.[LABEL];
      const snapshot = entry?.snapshot;
      if (entry && snapshot && entry.valid && snapshot.is_complete && typeof snapshot.total === "number") {
        picked = { parts, validation: entry, snapshot };
        break;
      }
    }

    if (!picked) {
      throw new Error(
        `No fully-valid, fully-priced build found in ${attempts} candidate combos from ${dbPath}.`
      );
    }

    // Challenger self-check: every product ID in the fixture resolves in the catalog.
    const ids = picked.snapshot.components.map((component) => component.product_id).filter(Boolean) as string[];
    const resolved = await repo.searchProducts({ product_ids: ids, inStockOnly: false, limit: ids.length }, scope);
    const found = new Set(resolved.results.map((product) => product.id));
    const unresolved = ids.filter((id) => !found.has(id));
    if (unresolved.length > 0) {
      throw new Error(`Fixture references products missing from catalog: ${unresolved.join(", ")}`);
    }

    const generatedAt = new Date().toISOString();
    const fixtureDate = generatedAt.slice(0, 10);
    const fixture = {
      version: 1,
      example: true,
      generated_at: generatedAt,
      source: { db: path.relative(process.cwd(), dbPath), scope },
      prompt: "Show me an example gaming build.",
      answer:
        `Example answer: a validated "${LABEL}" build totalling ` +
        `${formatPrice(picked.snapshot.total, picked.snapshot.currency)} across ` +
        `${picked.snapshot.component_count} catalog parts (prices observed ${fixtureDate}). ` +
        `Every part below is a real catalog listing and compatibility was checked ` +
        `by the deterministic engine.`,
      label: LABEL,
      validation: picked.validation,
      snapshot: picked.snapshot
    };

    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(process.cwd(), outPath)} (${scope.countryCode}/${scope.currency}, ${ids.length} parts, total ${formatPrice(picked.snapshot.total, picked.snapshot.currency)}).`);
  } finally {
    await repo.close?.();
  }
}

await main();
