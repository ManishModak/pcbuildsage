import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { getDb } from "./db";
import type { RegistryResearchEntry } from "./db-types";
import { normalizeTitle, slugifyComponent } from "./normalizer";

export type ComponentCategory = "cpu" | "gpu" | "motherboard" | "ram" | "storage" | "psu" | "case" | "cooler";
export type Confidence = "high" | "medium" | "low";
export type RegistrySpec = {
  brand: string;
  model: string;
  aliases: string[];
  sources?: string[];
  confidence?: Confidence;
  researched_at?: string;
  [key: string]: unknown;
};
export type ResolvedSpec = {
  key: string;
  category: ComponentCategory;
  spec: RegistrySpec;
  source: "registry" | "research";
  confidence: Confidence;
};

const CATEGORY_BY_FILE: Record<string, ComponentCategory> = {
  cpus: "cpu",
  gpus: "gpu",
  motherboards: "motherboard",
  ram: "ram",
  storage: "storage",
  psus: "psu",
  cases: "case",
  coolers: "cooler"
};

let cachedRegistry: ReturnType<typeof buildRegistry> | undefined;

export function loadRegistry(registryDir = path.join(process.cwd(), "data", "registry")) {
  cachedRegistry ??= buildRegistry(registryDir);
  return cachedRegistry;
}

export function resolveComponent(input: string | { key?: string; name?: string; category?: string }, options: { db?: Database.Database } = {}): ResolvedSpec | undefined {
  const registry = loadRegistry();
  const key = typeof input === "string" ? input : input.key;
  const name = typeof input === "string" ? input : input.name ?? input.key ?? "";
  const category = typeof input === "string" ? undefined : input.category;

  const canonical = key ? registry.byKey.get(key) : undefined;
  if (canonical && (!category || canonical.category === category)) return canonical;

  const normalized = normalizeTitle(name);
  const alias = registry.byAlias.get(normalized);
  if (alias && (!category || alias.category === category)) return alias;

  return lookupResearch({ key: key ?? slugifyComponent(name), name, category }, options.db ?? getDb());
}

export function listRegistrySpecs(category?: ComponentCategory): ResolvedSpec[] {
  const specs = Array.from(loadRegistry().byKey.values());
  return category ? specs.filter((item) => item.category === category) : specs;
}

function buildRegistry(registryDir: string) {
  const byKey = new Map<string, ResolvedSpec>();
  const byAlias = new Map<string, ResolvedSpec>();
  for (const file of readdirSync(registryDir).filter((entry) => entry.endsWith(".json"))) {
    const stem = file.replace(/\.json$/, "");
    const category = CATEGORY_BY_FILE[stem];
    if (!category) continue;
    const parsed = JSON.parse(readFileSync(path.join(registryDir, file), "utf8")) as Record<string, RegistrySpec | string>;
    for (const [key, spec] of Object.entries(parsed)) {
      if (key === "$schema" || typeof spec === "string") continue;
      const resolved: ResolvedSpec = { key, category, spec, source: "registry", confidence: "high" };
      byKey.set(key, resolved);
      for (const alias of [key, spec.model, spec.brand + " " + spec.model, ...(spec.aliases ?? [])]) {
        byAlias.set(normalizeTitle(alias), resolved);
      }
    }
  }
  return { byKey, byAlias };
}

function lookupResearch(input: { key: string; name: string; category?: string }, db: Database.Database): ResolvedSpec | undefined {
  const keys = [input.key, slugifyComponent(input.name)];
  const categoryClause = input.category ? "AND category = ?" : "";
  const params = input.category ? [...keys, input.category] : keys;
  const row = db
    .prepare(
      `SELECT key, category, specs, confidence, sources, researched_at
       FROM registry_research
       WHERE (key = ? OR key = ?)
       ${categoryClause}
       ORDER BY researched_at DESC
       LIMIT 1`
    )
    .get(...params) as RegistryResearchEntry | undefined;
  if (!row) return undefined;
  const spec = JSON.parse(row.specs) as RegistrySpec;
  return { key: row.key, category: row.category as ComponentCategory, spec, source: "research", confidence: row.confidence };
}
