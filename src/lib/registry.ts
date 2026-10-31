import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { getDb } from "@/lib/db";
import type { RegistryResearchEntry } from "@/types";
import { normalizeTitle, slugifyComponent } from "./normalizer";
import { canonicalizeFormFactor } from "./spec-canonical";
import { DASHLESS_ITX_CHIPSET, parseSpecsFromTitle, statesSodimm } from "./spec-parsers";
import { gpuVariant } from "./gpu-variant";

export type ComponentCategory = "cpu" | "gpu" | "motherboard" | "ram" | "storage" | "psu" | "case" | "cooler";
export type Confidence = "high" | "medium" | "low";
export type RegistrySpec = {
  brand: string;
  model: string;
  aliases: string[];
  segment?: string;
  sources?: string[];
  confidence?: Confidence;
  researched_at?: string;
  supported_memory?: string[];
  [key: string]: unknown;
};
export type ResolvedSpec = {
  key: string;
  category: ComponentCategory;
  spec: RegistrySpec;
  /** `derived` specs are read deterministically off the retailer's own product
   *  title (see spec-parsers.ts) - stated fact, not an LLM guess, so the rules
   *  engine may compute on them. */
  source: "registry" | "research" | "derived";
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

export function resolveComponent(
  input: string | { key?: string; name?: string; category?: string },
  options: { db?: Database.Database | null; skipDbLookup?: boolean } = {}
): ResolvedSpec | undefined {
  const registry = loadRegistry();
  const key = typeof input === "string" ? input : input.key;
  const name = typeof input === "string" ? input : input.name ?? input.key ?? "";
  const category = typeof input === "string" ? undefined : input.category;

  const keyed = key ? getRegistryEntry(registry.byKey, key) : undefined;
  // A catalog row's registry_key is itself a fuzzy match made at scrape time
  // ("MSI Pro B760M-A WIFI DDR4" was keyed to the DDR5 record), so the same
  // title-conflict guard applies to key hits as to alias hits. On conflict the
  // key is dropped entirely - including for the research lookup and the derived
  // key - and resolution falls through to alias / title parsing.
  const keyConflict = keyed && name !== key ? titleConflictsWithSpec(name, keyed.spec, keyed.category) : undefined;
  const canonical = keyConflict ? undefined : keyed;
  const trustedKey = keyConflict ? undefined : key;
  const normalized = normalizeTitle(name);
  const alias = registry.byAlias.get(normalized);
  const variant = gpuVariant(name);
  const compatible = (candidate: ResolvedSpec) => candidate.category !== "gpu" || (
    (!variant.family || gpuVariant(candidate.spec.model).family === variant.family) &&
    (!variant.ambiguousVram && (variant.vram === undefined || Number(candidate.spec.vram_gb) === variant.vram))
  );
  let hit =
    canonical && (!category || canonical.category === category)
      ? canonical
      : alias && (!category || alias.category === category) && !titleConflictsWithSpec(name, alias.spec, alias.category)
        ? alias
        : undefined;

  let rejectedGpu: ResolvedSpec | undefined;
  if (hit && !compatible(hit)) {
    rejectedGpu = hit;
    hit = undefined;
  }

  // Substring word-boundary match against canonical aliases (e.g., matching "MSI RTX 5060 Shadow..." to "nvidia-rtx-5060")
  if (!hit && normalized) {
    for (const { pattern, resolved } of registry.sortedAliases) {
      if (!category || resolved.category === category) {
        if (pattern.test(normalized) && compatible(resolved) && !titleConflictsWithSpec(name, resolved.spec, resolved.category)) {
          hit = resolved;
          break;
        }
      }
    }
  }

  // Retailer words can separate the model and capacity, defeating contiguous aliases.
  if (!hit && variant.family && variant.vram !== undefined && (!category || category === "gpu")) {
    hit = [...registry.byKey.values()].find((candidate) => candidate.category === "gpu" && /^(AMD|NVIDIA|Intel)$/i.test(candidate.spec.brand) && compatible(candidate));
  }

  const result = (() => {
    // A high/medium-confidence registry entry is the best answer available.
    if (hit && hit.confidence !== "low") {
      return hit.category === "gpu" ? withTitleGpuLength(hit, name) : hit;
    }

    // An unsourced registry entry is a placeholder, not a fact, so anything with a
    // provenance outranks it: a researched row (cites URLs), then a title parse
    // (quotes the retailer's own listing). The placeholder is still returned as a
    // last resort rather than nothing - flagged low, so the rules engine refuses to
    // compute a verdict from it and asks for research instead.
    if (!options.skipDbLookup && options.db !== null) {
      const researched = lookupResearch({ key: trustedKey ?? slugifyComponent(name), name, category }, options.db ?? getDb());
      if (researched && compatible(researched)) return normalizeResolvedSpec(researched);
      if (researched?.category === "gpu" && !compatible(researched)) rejectedGpu ??= researched;
    }

    const derived = parseSpecsFromTitle(name, category);
    if (derived) {
      return normalizeResolvedSpec({
        key: trustedKey ?? slugifyComponent(name),
        category: (category ?? "storage") as ComponentCategory,
        spec: derived,
        source: "derived" as const,
        confidence: "medium" as const
      });
    }

    return hit;
  })();

  if (rejectedGpu) {
    const conflict = `GPU listing variant conflicts with registry record ${rejectedGpu.key}; the conflicting record was not used.`;
    if (result) return {
      ...result,
      key: result.source === "derived" ? slugifyComponent(name) : result.key,
      spec: { ...result.spec, ...(variant.vram !== undefined ? { vram_gb: variant.vram } : {}), spec_conflict: conflict }
    };
    return {
      key: slugifyComponent(name), category: "gpu", source: "derived", confidence: "medium",
      spec: { brand: name.split(/\s+/)[0] ?? "", model: name, aliases: [name],
        ...(variant.vram !== undefined ? { vram_gb: variant.vram } : {}), spec_conflict: conflict }
    };
  }
  return result;
}

/**
 * The single narrow merge path for retailer-title GPU lengths. A stated length
 * the registry lacks is recorded with its title provenance; a length that
 * contradicts the registry record flags the dimension conflict without erasing
 * the other trusted GPU facts (validateBuild surfaces spec_conflict as
 * unverified). One board partner's title never rewrites a family record.
 */
export function withTitleGpuLength(hit: ResolvedSpec, name: string): ResolvedSpec {
  if (hit.category !== "gpu") return hit;
  const existing = typeof hit.spec.length_mm === "number" ? hit.spec.length_mm : undefined;
  const derived = parseSpecsFromTitle(name, "gpu");
  const stated = derived && typeof derived.length_mm === "number" ? derived.length_mm : undefined;
  if (existing === undefined) {
    if (stated === undefined) return hit;
    return {
      ...hit,
      spec: { ...hit.spec, length_mm: stated, length_mm_source: "listing-title" }
    };
  }
  if (stated === undefined || stated === existing) return hit;
  return {
    ...hit,
    spec: {
      ...hit.spec,
      spec_conflict: `GPU listing states card length ${stated}mm but the registry record ${hit.key} states ${existing}mm; the dimension is unverified.`
    }
  };
}

/**
 * Variant words in a listing title must not be silently overridden by an alias
 * hit. "MSI PRO B760M-A WIFI DDR4" substring-matches the DDR5 record
 * (alias "PRO B760M-A"), which let DDR5 RAM pass on a DDR4 board. When the
 * title states a conflicting spec - DDR generation, form factor, or laptop /
 * SO-DIMM packaging - the conflicting record is skipped so resolution falls
 * through to the correct record, a title parse, or unverified. Returns a
 * reason string on conflict, undefined otherwise.
 */
export function titleConflictsWithSpec(title: string, spec: RegistrySpec, category: ComponentCategory): string | undefined {
  if (category === "motherboard" || category === "ram") {
    const titleDdr = extractTitleDdr(title);
    const specDdr = typeof spec.ddr === "string" ? spec.ddr.toUpperCase() : undefined;
    if (titleDdr && (specDdr === "DDR4" || specDdr === "DDR5") && titleDdr !== specDdr) {
      return `listing states ${titleDdr} but the registry record states ${specDdr}`;
    }
  }

  if (category === "motherboard") {
    const titleFf = extractTitleFormFactor(title);
    if (titleFf && typeof spec.form_factor === "string" && spec.form_factor.length > 0) {
      const specFf = canonicalizeFormFactor(spec.form_factor);
      const specItx = specFf === "mini-itx" || specFf === "itx";
      if (titleFf === "mini-itx" && !specItx) {
        return `listing states Mini-ITX but the registry record is ${spec.form_factor}`;
      }
      if (titleFf !== "mini-itx" && specItx) {
        return `listing states ${titleFf} but the registry record is ${spec.form_factor}`;
      }
      if ((titleFf === "micro-atx" || titleFf === "atx" || titleFf === "e-atx") && specFf !== titleFf) {
        return `listing states ${titleFf} but the registry record is ${spec.form_factor}`;
      }
    }
  }

  if (category === "ram") {
    if (statesSodimm(title)) {
      const ff = typeof spec.form_factor === "string" ? spec.form_factor.toLowerCase().replace(/[\s\-_]/g, "") : "";
      const text = [spec.model, ...(spec.aliases ?? [])].join(" ");
      const specSodimm = ff === "sodimm" || statesSodimm(text);
      if (!specSodimm) {
        return "listing states laptop/SO-DIMM memory but the registry record is desktop memory";
      }
    }
  }

  return undefined;
}

/** DDR generation explicitly stated in a listing title ("DDR4", "D4" suffix). */
function extractTitleDdr(title: string): "DDR4" | "DDR5" | undefined {
  const upper = title.toUpperCase();
  const saysDdr5 = /\bDDR5\b/.test(upper) || /(?:^|[\s\-/])D5\b/.test(upper);
  const saysDdr4 = /\bDDR4\b/.test(upper) || /(?:^|[\s\-/])D4\b/.test(upper);
  if (saysDdr5 && !saysDdr4) return "DDR5";
  if (saysDdr4 && !saysDdr5) return "DDR4";
  return undefined;
}

/** Form factor explicitly stated in a listing title, incl. "-I" / dashless "B650I" ITX suffixes. */
function extractTitleFormFactor(title: string): "mini-itx" | "micro-atx" | "atx" | "e-atx" | undefined {
  const upper = title.toUpperCase();
  if (/\bMINI[-\s]?ITX\b/.test(upper) || /\bITX\b/.test(upper) || /\b[A-Z]+\d+[A-Z]*-I\b/.test(upper) || DASHLESS_ITX_CHIPSET.test(upper)) return "mini-itx";
  if (/\bE[-\s]?ATX\b/.test(upper)) return "e-atx";
  if (
    /\bMICRO[-\s]?ATX\b/.test(upper) ||
    /\bM[-\s]?ATX\b/.test(upper) ||
    /\bU[-\s]?ATX\b/.test(upper) ||
    /\b[A-Z]\d{3}M\b/.test(upper) ||
    /\b[A-Z]\d{3}M-/.test(upper)
  ) {
    return "micro-atx";
  }
  if (/\bATX\b/.test(upper)) return "atx";
  return undefined;
}

export function hasWattageConflict(spec: RegistrySpec): boolean {
  return Boolean(spec.wattage_conflict || (
    spec.wattage !== undefined && spec.wattage_w !== undefined &&
    Number(spec.wattage) !== Number(spec.wattage_w)
  ));
}

export function normalizeResolvedSpec(resolved?: ResolvedSpec): ResolvedSpec | undefined {
  if (!resolved || !resolved.spec) return resolved;
  const spec = { ...resolved.spec };
  if (spec.wattage_w !== undefined && spec.wattage === undefined) {
    spec.wattage = spec.wattage_w;
  } else if (
    hasWattageConflict(spec)
  ) {
    spec.wattage_conflict = true;
  }

  if (spec.capacity_gb === undefined && typeof spec.capacity === "string") {
    const match = spec.capacity.match(/^(\d+)\s*GB$/i);
    if (match) {
      spec.capacity_gb = parseInt(match[1], 10);
    }
  }

  return { ...resolved, spec };
}

export function listRegistrySpecs(category?: ComponentCategory): ResolvedSpec[] {
  const specs = Array.from(loadRegistry().byKey.values());
  return category ? specs.filter((item) => item.category === category) : specs;
}

/**
 * A registry entry is trustworthy only if it can say where its numbers came from.
 *
 * The seed registry was written in one pass and never sourced: the RTX 5090 is
 * listed at 8GB/200W (it is 32GB/575W), and 151 of 157 coolers are rated at
 * exactly 150W. Stamping those "high" - as this function's predecessor did
 * unconditionally - let them sail through every confidence gate, so validate_build
 * would approve a 550W PSU for a 575W card. Absent citations, an entry is a
 * placeholder and is marked low so the rules engine will not compute a verdict
 * from it; consult researches it, and the sourced result outranks it.
 */
function entryConfidence(spec: RegistrySpec): Confidence {
  if (spec.confidence === "high" || spec.confidence === "medium" || spec.confidence === "low") return spec.confidence;
  return Array.isArray(spec.sources) && spec.sources.length > 0 ? "high" : "low";
}

export const LEGACY_KEY_MAP: Record<string, string> = {
  "be-quiet-dark-power-pro-12-850w": "be-quiet-dark-power-12-850w",
  "g-skill-ripjaws-v-16gb-ddr4-3200": "g-skill-ripjaws-v-16gb-2x8gb-ddr4-3200"
};

/**
 * Explicit legacy-key translation at the lookup boundary. Canonical entries
 * live in a plain Map (one listing per entry for listRegistrySpecs); legacy
 * keys redirect without duplicating the entry.
 */
function getRegistryEntry(byKey: Map<string, ResolvedSpec>, key: string): ResolvedSpec | undefined {
  return byKey.get(key) ?? (LEGACY_KEY_MAP[key] !== undefined ? byKey.get(LEGACY_KEY_MAP[key]) : undefined);
}

function buildRegistry(registryDir: string) {
  const byKey = new Map<string, ResolvedSpec>();
  const byAlias = new Map<string, ResolvedSpec>();
  const sortedAliases: Array<{ pattern: RegExp; resolved: ResolvedSpec; length: number }> = [];

  for (const file of readdirSync(registryDir).filter((entry) => entry.endsWith(".json"))) {
    const stem = file.replace(/\.json$/, "");
    const category = CATEGORY_BY_FILE[stem];
    if (!category) continue;
    const parsed = JSON.parse(readFileSync(path.join(registryDir, file), "utf8")) as Record<string, RegistrySpec | string>;
    for (const [key, spec] of Object.entries(parsed)) {
      if (key === "$schema" || typeof spec === "string") continue;
      const rawResolved: ResolvedSpec = { key, category, spec, source: "registry", confidence: entryConfidence(spec) };
      const resolved = normalizeResolvedSpec(rawResolved);
      if (!resolved) continue;
      byKey.set(key, resolved);
      for (const alias of [key, spec.model, spec.brand + " " + spec.model, ...(spec.aliases ?? [])]) {
        const norm = normalizeTitle(alias);
        if (norm) {
          byAlias.set(norm, resolved);
          if (norm.length >= 3) {
            const escaped = norm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            sortedAliases.push({
              pattern: new RegExp(`\\b${escaped}\\b`, "i"),
              resolved,
              length: norm.length
            });
          }
        }
      }
    }
  }

  // Sort longest alias first so "rtx 5070 ti" matches before "rtx 5070"
  sortedAliases.sort((a, b) => b.length - a.length);

  return { byKey, byAlias, sortedAliases };
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
