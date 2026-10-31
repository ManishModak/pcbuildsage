#!/usr/bin/env tsx
/**
 * scripts/import-blender-benchmarks.ts
 *
 * Builds the rendering benchmark dataset (data/benchmarks/blender-<version>-rendering.json)
 * from a Blender Open Data snapshot (CC0, https://opendata.blender.org/download/).
 * Run it by hand when a new Blender release has enough runs; it never downloads
 * anything and never runs in CI.
 *
 * Usage: unzip -p opendata-latest.zip '*.jsonl' | npm run -s import-blender-benchmarks -- \
 *          --blender 5.2 --snapshot 2026-10-31 [--min-runs 10]
 *
 * Keeps runs of one Blender release, each GPU vendor's fastest backend
 * (OptiX, HIP, oneAPI) and single-socket CPUs. Per part and scene it takes the
 * median samples per minute; a part's score is the geometric mean over the
 * scenes, relative to its category baseline (= 100). Device names map to
 * chip-level registry entries by exact name, so laptop parts never match a
 * desktop chip. Names it can't map are printed so coverage gaps are visible.
 */

import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export type Category = "gpu" | "cpu";

export const SCENES = ["monster", "junkshop", "classroom"] as const;
export const BASELINES: Record<Category, string> = { gpu: "nvidia-rtx-4060", cpu: "amd-ryzen-5-7600" };
const GPU_BACKENDS: Record<string, string> = { OPTIX: "nvidia", HIP: "amd", ONEAPI: "intel" };

/**
 * Registry chips that Blender reports under one name and that share a GPU
 * die and memory bus, differing only in VRAM size. They share a score. Other
 * same-name pairs differ in cores or bus width (RTX 3050 6GB/8GB, RTX 3060
 * 8GB/12GB, RTX 3080 10GB/12GB, RTX 2060 6GB/12GB) or have 4GB variants that
 * the test scenes can exceed, so they stay unscored.
 */
export const SAME_CHIP_VRAM_VARIANTS = new Set(["rtx 5060 ti", "rtx 4060 ti", "rx 9060 xt", "arc a770"]);

/** Reduces a registry model or Blender device name to a comparable chip name. */
export function chipName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\((r|tm)\)/g, " ")
    .replace(/\b\d+(st|nd|rd|th) gen\b/g, " ")
    .replace(/\bcpu @ .*$/, " ")
    .replace(/\b\d+-core processor\b|\bprocessor\b/g, " ")
    .replace(/\b(with|w\/) radeon.*$/, " ")
    .replace(/\bgraphics\b/g, " ")
    .replace(/\b(nvidia|amd|intel|geforce|radeon)\b/g, " ")
    .replace(/\b\d+\s*gb\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type RegistryFile = Record<string, { model?: string; chip?: string } | string>;

/**
 * Maps chip names to registry keys. Board-partner cards (entries with `chip`)
 * are skipped: scores are per chip. A name shared by several chips maps only
 * when it is a known VRAM-only variant group.
 */
export function buildChipIndex(registry: RegistryFile): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const [key, entry] of Object.entries(registry)) {
    if (key === "$schema" || typeof entry === "string" || !entry.model || entry.chip !== undefined) continue;
    const name = chipName(entry.model);
    byName.set(name, [...(byName.get(name) ?? []), key]);
  }
  for (const [name, keys] of byName) {
    if (keys.length > 1 && !SAME_CHIP_VRAM_VARIANTS.has(name)) byName.delete(name);
  }
  return byName;
}

export type BenchmarkRun = { category: Category; device: string; scene: string; samplesPerMinute: number };

type OpenDataRow = {
  blender_version?: { label?: unknown };
  scene?: { label?: unknown };
  stats?: { samples_per_minute?: unknown };
  device_info?: { device_type?: unknown; compute_devices?: unknown };
  system_info?: { num_cpu_sockets?: unknown };
};

/** Extracts usable runs from one Blender Open Data JSONL line. */
export function parseRuns(line: string, blenderRelease: string): BenchmarkRun[] {
  let doc: unknown;
  try {
    doc = JSON.parse(line);
  } catch {
    return [];
  }
  const data = (doc as { data?: unknown } | null)?.data;
  const rows: unknown[] = Array.isArray(data) ? data : data && typeof data === "object" ? [data] : [];
  const runs: BenchmarkRun[] = [];
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const row = item as OpenDataRow;
    if (!String(row.blender_version?.label ?? "").startsWith(`${blenderRelease}.`)) continue;
    const scene = row.scene?.label;
    const samplesPerMinute = Number(row.stats?.samples_per_minute);
    const devices = row.device_info?.compute_devices;
    const deviceType = String(row.device_info?.device_type ?? "");
    if (typeof scene !== "string" || !Number.isFinite(samplesPerMinute) || samplesPerMinute <= 0) continue;
    if (!Array.isArray(devices) || devices.length !== 1) continue;
    const device = (devices[0] as { name?: unknown } | null)?.name;
    if (typeof device !== "string") continue;
    if (deviceType === "CPU") {
      if (row.system_info?.num_cpu_sockets !== 1) continue;
      runs.push({ category: "cpu", device, scene, samplesPerMinute });
    } else if (GPU_BACKENDS[deviceType] && chipVendor(device) === GPU_BACKENDS[deviceType]) {
      runs.push({ category: "gpu", device, scene, samplesPerMinute });
    }
  }
  return runs;
}

function chipVendor(device: string): string | undefined {
  const lower = device.toLowerCase();
  if (/\b(nvidia|geforce|rtx|gtx|quadro)\b/.test(lower)) return "nvidia";
  if (/\b(amd|radeon)\b/.test(lower)) return "amd";
  if (/\b(intel|arc)\b/.test(lower)) return "intel";
  return undefined;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export type Aggregate = {
  scores: Record<Category, Record<string, number>>;
  runs: Record<string, number>;
  unmapped: Array<{ category: Category; device: string; runs: number }>;
  shared: string[][];
};

/**
 * Turns runs into scores: per registry key and scene the median samples per
 * minute (at least `minRuns` runs in every scene), then the geometric mean over
 * scenes, relative to the category baseline. Throws when a baseline is unscored.
 */
export function aggregateRuns(
  runs: Iterable<BenchmarkRun>,
  chipIndex: Record<Category, Map<string, string[]>>,
  minRuns: number
): Aggregate {
  const samples = new Map<string, Map<string, number[]>>();
  const unmappedCounts = new Map<string, { category: Category; device: string; runs: number }>();
  for (const run of runs) {
    const keys = chipIndex[run.category].get(chipName(run.device));
    if (!keys) {
      const id = `${run.category}:${chipName(run.device)}`;
      const entry = unmappedCounts.get(id) ?? { category: run.category, device: run.device, runs: 0 };
      entry.runs++;
      unmappedCounts.set(id, entry);
      continue;
    }
    const groupId = `${run.category}:${keys.join(",")}`;
    const byScene = samples.get(groupId) ?? new Map<string, number[]>();
    byScene.set(run.scene, [...(byScene.get(run.scene) ?? []), run.samplesPerMinute]);
    samples.set(groupId, byScene);
  }

  const raw: Record<Category, Map<string, { value: number; runs: number }>> = { gpu: new Map(), cpu: new Map() };
  const shared: string[][] = [];
  for (const [groupId, byScene] of samples) {
    const [category, keyList] = groupId.split(":") as [Category, string];
    const counts = SCENES.map((scene) => byScene.get(scene)?.length ?? 0);
    if (Math.min(...counts) < minRuns) continue;
    const logMean = SCENES.reduce((sum, scene) => sum + Math.log(median(byScene.get(scene)!)), 0) / SCENES.length;
    const keys = keyList.split(",");
    if (keys.length > 1) shared.push(keys);
    for (const key of keys) raw[category].set(key, { value: Math.exp(logMean), runs: Math.min(...counts) });
  }

  const scores: Aggregate["scores"] = { gpu: {}, cpu: {} };
  const runCounts: Record<string, number> = {};
  for (const category of ["gpu", "cpu"] as const) {
    const baseline = raw[category].get(BASELINES[category]);
    if (!baseline) throw new Error(`Baseline ${BASELINES[category]} has fewer than ${minRuns} runs in some scene.`);
    const ranked = [...raw[category]].sort((a, b) => b[1].value - a[1].value);
    for (const [key, { value, runs }] of ranked) {
      // Whole numbers: run-to-run noise is several percent, so decimals would overstate precision.
      scores[category][key] = Math.round((value / baseline.value) * 100);
      runCounts[key] = runs;
    }
  }
  const unmapped = [...unmappedCounts.values()].sort((a, b) => b.runs - a.runs);
  return { scores, runs: runCounts, unmapped, shared };
}

/** Assembles the dataset file that data/schemas/benchmark.schema.json validates. */
export function toDataset(aggregate: Aggregate, blenderRelease: string, snapshot: string, minRuns: number) {
  const sharedNote = aggregate.shared.length
    ? ` VRAM variants of one chip share a score: ${aggregate.shared.map((keys) => keys.join(" = ")).join("; ")}.`
    : "";
  return {
    $schema: "../schemas/benchmark.schema.json",
    id: `blender-${blenderRelease}-rendering`,
    metric: "rendering",
    source: { name: "Blender Open Data", url: "https://opendata.blender.org/", licence: "CC0-1.0", snapshot },
    method:
      `Blender ${blenderRelease}.x; scenes ${SCENES.join(", ")}; median samples per minute per scene over at least ` +
      `${minRuns} runs; geometric mean of the scenes. GPUs on their vendor's fastest backend (OptiX, HIP, oneAPI); ` +
      `CPUs on single-socket systems. User-submitted runs vary by several percent (AMD GPUs more, with HIP driver and settings), ` +
      `so treat gaps under 10% as a tie.${sharedNote}`,
    baselines: BASELINES,
    scores: aggregate.scores,
    runs: aggregate.runs
  };
}

async function* readRuns(input: NodeJS.ReadableStream, blenderRelease: string): AsyncGenerator<BenchmarkRun> {
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
    yield* parseRuns(line, blenderRelease);
  }
}

export async function runImport(argv = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      blender: { type: "string" },
      snapshot: { type: "string" },
      "min-runs": { type: "string", default: "10" },
      out: { type: "string" }
    }
  });
  const blenderRelease = values.blender;
  const snapshot = values.snapshot;
  const minRuns = Number(values["min-runs"]);
  if (!blenderRelease || !/^\d+\.\d+$/.test(blenderRelease) || !snapshot || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot) || !(minRuns >= 1)) {
    console.error("Usage: unzip -p opendata-latest.zip '*.jsonl' | npm run -s import-blender-benchmarks -- --blender 5.2 --snapshot YYYY-MM-DD [--min-runs 10] [--out file]");
    return 2;
  }

  const read = (file: string) => JSON.parse(fs.readFileSync(path.join("data", "registry", file), "utf8")) as RegistryFile;
  const chipIndex = { gpu: buildChipIndex(read("gpus.json")), cpu: buildChipIndex(read("cpus.json")) };
  const collected: BenchmarkRun[] = [];
  for await (const run of readRuns(process.stdin, blenderRelease)) collected.push(run);

  const aggregate = aggregateRuns(collected, chipIndex, minRuns);
  const dataset = toDataset(aggregate, blenderRelease, snapshot, minRuns);
  const out = values.out ?? path.join("data", "benchmarks", `${dataset.id}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(dataset, null, 2)}\n`);

  console.error(
    `Wrote ${out}: ${Object.keys(aggregate.scores.gpu).length} GPUs, ${Object.keys(aggregate.scores.cpu).length} CPUs ` +
      `from ${collected.length} Blender ${blenderRelease} runs.`
  );
  console.error("Most-run device names with no registry chip (add the chip to the registry to score it):");
  for (const { category, device, runs } of aggregate.unmapped.slice(0, 30)) console.error(`  ${category} ${runs}\t${device}`);
  return 0;
}

const isMain = Boolean(
  process.argv[1] &&
    (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
      process.argv[1].endsWith("import-blender-benchmarks.ts"))
);

if (isMain) {
  runImport()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("[import-blender-benchmarks]", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
