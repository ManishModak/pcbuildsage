import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { AnySchema } from "ajv";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

type ValidationTarget = {
  name: string;
  schemaPath: string;
  dataDir: string;
  recursive?: boolean;
};

const targets: ValidationTarget[] = [
  {
    name: "registry",
    schemaPath: "data/schemas/registry.schema.json",
    dataDir: "data/registry",
    recursive: true
  },
  {
    name: "profiles",
    schemaPath: "data/schemas/profile.schema.json",
    dataDir: "data/profiles"
  },
  {
    name: "themes",
    schemaPath: "data/schemas/theme.schema.json",
    dataDir: "data/themes"
  },
  {
    name: "personalities",
    schemaPath: "data/schemas/personality.schema.json",
    dataDir: "data/personalities"
  },
  {
    name: "endpoints",
    schemaPath: "data/schemas/endpoint.schema.json",
    dataDir: "data/endpoints"
  },
  {
    name: "search",
    schemaPath: "data/schemas/search.schema.json",
    dataDir: "data/search"
  },
  {
    name: "benchmarks",
    schemaPath: "data/schemas/benchmark.schema.json",
    dataDir: "data/benchmarks"
  }
];

// Benchmark scores are keyed by chip-level entries in these registry files.
const BENCHMARK_REGISTRY_FILES = { gpu: "data/registry/gpus.json", cpu: "data/registry/cpus.json" } as const;
const benchmarkMetricFiles = new Map<string, string>();

const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);

let hasErrors = false;

for (const target of targets) {
  const schema = readJson<AnySchema>(target.schemaPath);

  if (!schema.ok) {
    hasErrors = true;
    continue;
  }

  const validate = ajv.compile(stripNonSchemaKeywords(schema.value));
  const files = listJsonFiles(target.dataDir, target.recursive).sort();

  for (const filePath of files) {
    const data = readJson(filePath);

    if (!data.ok) {
      hasErrors = true;
      continue;
    }

    const valid = validate(data.value);

    if (!valid) {
      hasErrors = true;
      console.error(`${filePath} invalid against schema`);
      console.error(ajv.errorsText(validate.errors, { separator: "\n" }));
      continue;
    }

    // Custom semantic validations
    if (target.name === "themes") {
      const theme = data.value as Record<string, unknown>;
      if (theme.tokens) {
        const tokens = theme.tokens as Record<string, string>;
        const bg = tokens["--bg"];
        const surface = tokens["--surface"];
        
        const checks = [
          { name: "--text vs --bg", fg: tokens["--text"], bg: bg, threshold: 4.5 },
          { name: "--text-secondary vs --bg", fg: tokens["--text-secondary"], bg: bg, threshold: 4.5 },
          { name: "--accent vs --bg", fg: tokens["--accent"], bg: bg, threshold: 3.0 },
          { name: "--on-accent vs --accent", fg: tokens["--on-accent"], bg: tokens["--accent"], threshold: 4.5 },
          { name: "--text vs --surface", fg: tokens["--text"], bg: surface, threshold: 4.5 },
        ];

        let themeHasErrors = false;
        for (const check of checks) {
          if (check.fg && check.bg) {
            try {
              const ratio = getContrastRatio(check.fg, check.bg);
              if (ratio < check.threshold) {
                themeHasErrors = true;
                hasErrors = true;
                console.error(`${filePath} invalid: WCAG contrast check failed for ${check.name}. Ratio is ${ratio.toFixed(2)}:1 (minimum ${check.threshold}:1 required).`);
              }
            } catch (err) {
              themeHasErrors = true;
              hasErrors = true;
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`${filePath} invalid: WCAG contrast check failed for ${check.name}. Error parsing colors: ${msg}`);
            }
          }
        }
        if (themeHasErrors) {
          continue;
        }
      }
    }

    if (target.name === "registry") {
      const category = path.basename(filePath, ".json");
      const entries = data.value as Record<string, Record<string, unknown>>;
      // Per-category allowed fields are owned by the schema (x-category-fields):
      // the common $defs/component shape cannot express them. wattage_w is
      // intentionally absent - curated JSON stores wattage only; the runtime
      // still normalizes legacy wattage_w from external research data.
      const categoryFields = (schema.value as { "x-category-fields"?: Record<string, string[]> })["x-category-fields"];

      const allowed = categoryFields?.[category];
      let registryHasErrors = false;

      if (!allowed) {
        hasErrors = true;
        console.error(`${filePath}: no x-category-fields metadata for category "${category}" in registry schema.`);
        continue;
      }

      for (const [key, spec] of Object.entries(entries)) {
        if (key === "$schema" || typeof spec !== "object" || !spec) continue;

        // Check for wrong-category fields
        for (const field of Object.keys(spec)) {
          if (!allowed.includes(field)) {
            registryHasErrors = true;
            hasErrors = true;
            console.error(`${filePath}: entry "${key}" contains wrong-category field "${field}" for category "${category}".`);
          }
        }

        // Semantic checks for contradictions
        if (category === "ram") {
          if (typeof spec.capacity === "string" && typeof spec.capacity_gb === "number") {
            const match = spec.capacity.match(/^(\d+)\s*GB$/i);
            if (match && parseInt(match[1], 10) !== spec.capacity_gb) {
              registryHasErrors = true;
              hasErrors = true;
              console.error(`${filePath}: entry "${key}" has conflicting capacity (${spec.capacity}) and capacity_gb (${spec.capacity_gb}).`);
            }
          }
        }

        if (category === "coolers") {
          if (spec.cooler_type === "air" && spec.radiator_size_mm !== undefined) {
            registryHasErrors = true;
            hasErrors = true;
            console.error(`${filePath}: entry "${key}" is classified as air cooler but defines radiator_size_mm.`);
          }
        }

        if (category === "gpus" && spec.chip !== undefined) {
          const chip = entries[spec.chip as string];
          if (spec.chip === key || !chip || typeof chip !== "object" || chip.chip !== undefined) {
            registryHasErrors = true;
            hasErrors = true;
            console.error(`${filePath}: entry "${key}" has chip "${String(spec.chip)}", which must be another gpus.json entry without its own chip.`);
          }
        }
      }

      if (registryHasErrors) {
        continue;
      }
    }

    if (target.name === "benchmarks") {
      const errors = benchmarkErrors(data.value as BenchmarkFile, filePath);
      if (errors.length > 0) {
        hasErrors = true;
        for (const error of errors) console.error(`${filePath}: ${error}`);
        continue;
      }
    }

    console.log(`${filePath} valid`);
  }
}

if (hasErrors) {
  process.exitCode = 1;
}

type BenchmarkFile = {
  metric: string;
  baselines: Partial<Record<keyof typeof BENCHMARK_REGISTRY_FILES, string>>;
  scores: Partial<Record<keyof typeof BENCHMARK_REGISTRY_FILES, Record<string, number>>>;
  runs: Record<string, number>;
};

/**
 * Checks a schema-valid benchmark dataset against the registry: one dataset
 * per metric, every baseline scores exactly 100, every score key is a chip
 * entry (not a board-partner card), and every score has a run count.
 */
function benchmarkErrors(dataset: BenchmarkFile, filePath: string): string[] {
  const errors: string[] = [];
  const earlier = benchmarkMetricFiles.get(dataset.metric);
  if (earlier) errors.push(`metric "${dataset.metric}" is already provided by ${earlier}; keep one dataset per metric.`);
  benchmarkMetricFiles.set(dataset.metric, filePath);

  const scoredKeys = new Set<string>();
  for (const category of Object.keys(BENCHMARK_REGISTRY_FILES) as Array<keyof typeof BENCHMARK_REGISTRY_FILES>) {
    const scores = dataset.scores[category];
    const baseline = dataset.baselines[category];
    if (!scores) {
      if (baseline) errors.push(`baselines.${category} is set but scores.${category} is missing.`);
      continue;
    }
    if (!baseline || scores[baseline] !== 100) {
      errors.push(`scores.${category} needs its baseline (${baseline ?? "unset"}) at exactly 100.`);
    }
    const registry = readJson<Record<string, Record<string, unknown>>>(BENCHMARK_REGISTRY_FILES[category]);
    if (!registry.ok) {
      errors.push(`could not read ${BENCHMARK_REGISTRY_FILES[category]}.`);
      continue;
    }
    for (const key of Object.keys(scores)) {
      scoredKeys.add(key);
      const entry = registry.value[key];
      if (!entry || typeof entry !== "object") errors.push(`scores.${category}.${key} is not a key in ${BENCHMARK_REGISTRY_FILES[category]}.`);
      else if (entry.chip !== undefined) errors.push(`scores.${category}.${key} is a board-partner card; score its chip (${String(entry.chip)}) instead.`);
      if (dataset.runs[key] === undefined) errors.push(`runs.${key} is missing.`);
    }
  }
  for (const key of Object.keys(dataset.runs)) {
    if (!scoredKeys.has(key)) errors.push(`runs.${key} has no score.`);
  }
  return errors;
}

function listJsonFiles(dir: string, recursive = false): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const entryPath = path.join(dir, entry);
    const stat = statSync(entryPath);

    if (stat.isDirectory() && recursive) {
      files.push(...listJsonFiles(entryPath, true));
      continue;
    }

    if (stat.isFile() && entry.endsWith(".json")) {
      files.push(entryPath);
    }
  }

  return files;
}

/**
 * Removes script-consumed metadata (x-* keywords) before handing the schema to
 * AJV, which rejects unknown keywords in strict mode. The schema file remains
 * the single owner of that metadata.
 */
function stripNonSchemaKeywords(schema: AnySchema): AnySchema {
  if (typeof schema !== "object" || schema === null) return schema;
  const rest = { ...(schema as Record<string, unknown>) };
  delete rest["x-category-fields"];
  return rest as AnySchema;
}

function readJson<T = unknown>(filePath: string): { ok: true; value: T } | { ok: false } {  try {
    return { ok: true, value: JSON.parse(readFileSync(path.resolve(filePath), "utf8")) as T };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${filePath} invalid JSON`);
    console.error(message);
    return { ok: false };
  }
}

function getContrastRatio(hex1: string, hex2: string): number {
  const l1 = getRelativeLuminance(hex1);
  const l2 = getRelativeLuminance(hex2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function getRelativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    throw new Error(`Invalid hex color: "${hex}"`);
  }
  const r = adjustColorChannel(rgb.r);
  const g = adjustColorChannel(rgb.g);
  const b = adjustColorChannel(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  return match
    ? {
        r: parseInt(match[1], 16),
        g: parseInt(match[2], 16),
        b: parseInt(match[3], 16)
      }
    : null;
}

function adjustColorChannel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
