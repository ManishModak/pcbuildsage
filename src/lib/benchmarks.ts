import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadRegistry } from "./registry";

/** Workloads with a checked-in dataset; list_models offers exactly these. */
export const PERFORMANCE_METRICS = ["rendering"] as const;
export type PerformanceMetric = (typeof PERFORMANCE_METRICS)[number];
export type ScoredCategory = "gpu" | "cpu";

/** One benchmark source, as validated by data/schemas/benchmark.schema.json. */
export type BenchmarkDataset = {
  id: string;
  metric: PerformanceMetric;
  source: { name: string; url: string; licence: string; snapshot: string };
  method: string;
  baselines: Partial<Record<ScoredCategory, string>>;
  scores: Partial<Record<ScoredCategory, Record<string, number>>>;
  runs: Record<string, number>;
};

let cachedDatasets: BenchmarkDataset[] | undefined;

/** Loads data/benchmarks/*.json once; validate:data keeps one dataset per metric. */
export function loadBenchmarks(dir = path.join(process.cwd(), "data", "benchmarks")): BenchmarkDataset[] {
  cachedDatasets ??= existsSync(dir)
    ? readdirSync(dir)
        .filter((file) => file.endsWith(".json"))
        .map((file) => JSON.parse(readFileSync(path.join(dir, file), "utf8")) as BenchmarkDataset)
    : [];
  return cachedDatasets;
}

/**
 * A part's score in a dataset, or undefined when it has none. Board-partner
 * GPU entries carry a `chip` link and use their chip's score.
 */
export function benchmarkScore(
  dataset: BenchmarkDataset,
  category: ScoredCategory,
  registryKey: string | undefined
): number | undefined {
  if (!registryKey) return undefined;
  const chip = loadRegistry().byKey.get(registryKey)?.spec.chip;
  return dataset.scores[category]?.[typeof chip === "string" ? chip : registryKey];
}
