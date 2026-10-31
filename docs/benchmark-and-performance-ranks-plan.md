# Plan: benchmark scores in `list_models`

> **Status:** plan only; nothing is built yet.
> **History:** first written 13 Sep 2026. Reworked 31 Oct 2026 against current master: it now names a data source, uses `list_models` instead of a new tool, and stores provenance once per dataset. See [What changed from the 13 Sep plan](#what-changed-from-the-13-sep-plan).

## Problem

Models don't know parts released after their training cutoff (RTX 50-series, RX 9000-series, Ryzen 9000, Core Ultra 200). They guess performance tiers, and they can't say how much faster one shortlisted part is or what it costs per unit of performance. PCBuildSage should answer that from local, cited data, and say plainly when it has none.

## Decisions

| Area | Decision | Why |
| :--- | :--- | :--- |
| Unit of scoring | One score per **chip** (e.g. `nvidia-rtx-5060-ti-8gb`), not per board-partner card. | Partner cards of one chip perform within a few percent; benchmarks report chips. |
| Scale | Relative index, baseline = 100. GPU baseline `nvidia-rtx-4060`, CPU baseline `amd-ryzen-5-7600`. | Linear and easy to read; both baselines are common current parts. |
| Metrics | `rendering` (CPU and GPU) now. `gaming_1080p`, `gaming_1440p`, `gaming_4k` (GPU) and `gaming` (CPU) are reserved until a gaming source is settled. | Only rendering has an openly licensed source today (see [Data sources](#data-sources)). |
| Separation | A score is only compared with scores of the same metric from the same dataset. Rendering scores never answer a gaming question. | In Blender the RX 9070 XT scores about the same as an RTX 4060, yet in games it's in a much higher class. Mixing metrics would mislead. |
| Provenance | Stored once per dataset file (source, licence, snapshot date, method, baseline), not on every registry entry. | The 13 Sep plan repeated baseline, dataset, source and date on every metric of every part. |
| Missing data | A part without a score gets `perf: null`. It is never filtered out, never blocks validation, and never triggers web research. | Scores are optional enrichment. |
| Tool surface | Extend `list_models`. No new tool, and no changes to `search_products`, `validate_build` or `present_build`. | `list_models` already returns one row per model with its price range, and the prompt already sends the model there before `search_products`. Each tool adds context to every chat turn and MCP session, which matters for small local models. Decided 31 Oct. |
| CPU/GPU balance | Deferred, unchanged from the 13 Sep plan. | No evidence-backed pairing rules yet; CPU and GPU indices are never compared with each other. |

## Data sources

### Rendering: Blender Open Data (chosen)

- **Licence:** CC0 (public domain), stated on <https://opendata.blender.org/download/> and in the archive's `LICENSE.txt`. Confirmed 31 Oct 2026.
- **What it is:** a daily snapshot (about 100 MB zipped, 1.9 GB JSONL) of Blender Benchmark runs uploaded by users: Blender version, scene, device, backend (OptiX, CUDA, HIP, oneAPI, Metal, CPU) and samples per minute.
- **Coverage, checked on the 31 Oct snapshot** (Blender 4.2–5.2, `monster` scene, median samples per minute, number of runs):

  | Part | Backend | Median | Runs |
  | :--- | :--- | ---: | ---: |
  | RTX 4060 | OptiX | 1497 | 4072 |
  | RTX 5060 | OptiX | 1568 | 1446 |
  | RTX 5060 Ti | OptiX | 1990 | 1468 |
  | RTX 5070 | OptiX | 2762 | 2418 |
  | RX 9060 XT | HIP | 795 | 407 |
  | RX 9070 XT | HIP | 1558 | 1842 |
  | Arc B580 | oneAPI | 1033 | 375 |
  | Ryzen 5 7600 | CPU | 88 | 311 |
  | Ryzen 7 9800X3D | CPU | 151 | 2826 |
  | Core i5-14400F | CPU | 91 | 124 |
  | Core Ultra 7 265K | CPU | 217 | 881 |

  These mix several Blender versions and are only a coverage check, not the method below.
- **Limits:** device names don't carry VRAM size (RX 9060 XT 8 GB and 16 GB report the same name), and the data measures Cycles path tracing only.

### Gaming: open decision

No openly licensed gaming benchmark dataset was found (searched 31 Oct 2026):

- **TechPowerUp, Tom's Hardware, 3DCenter:** on `DENIED_CRAWL_DOMAINS` (`src/lib/web-search.ts`) because their terms forbid scraping or text and data mining. TechPowerUp's footer says "All rights reserved"; no terms page granting reuse was found.
- **PassMark:** staff on its forum say the data may not be copied, but they offer to discuss a licence.
- **GPU Ark** (Hugging Face, CC BY 4.0): its 993 benchmark results are compute tests (llama.cpp, Hashcat) taken from OpenBenchmarking, not games.
- **Kaggle "GPUs FPS" sets:** tagged CC0 but scraped from gpucheck.com, so the tag can't be relied on.
- **Open Game Benchmarks** (GitHub) and similar projects: tools for collecting results, not maintained datasets.

That the project is open source doesn't change this: our code's licence gives us no right to another site's data. The options are:
1. Ask a reviewer for a licence with credit (TechPowerUp's relative performance, or PassMark).
2. Have a person enter scores by hand from several cited reviews, never scraped. Measured numbers are facts, but sites' terms and EU database rights may still apply. This isn't legal advice.
3. Collect our own results later.

The data format below already supports a gaming dataset; adding one is a data change plus new values in the metric enum.

## Data format

One JSON file per dataset in `data/benchmarks/`, validated by a new `data/schemas/benchmark.schema.json`:

```jsonc
// data/benchmarks/blender-5.2-rendering.json
{
  "$schema": "../schemas/benchmark.schema.json",
  "id": "blender-5.2-rendering",
  "metric": "rendering",
  "source": {
    "name": "Blender Open Data",
    "url": "https://opendata.blender.org/",
    "licence": "CC0-1.0",
    "snapshot": "2026-10-31"
  },
  "method": "Blender 5.2.0; scenes monster, junkshop, classroom; median samples per minute per scene over at least 20 runs; geometric mean of the three scenes; GPUs on their vendor's fastest backend (OptiX, HIP, oneAPI).",
  "baselines": { "gpu": "nvidia-rtx-4060", "cpu": "amd-ryzen-5-7600" },
  "scores": {
    "gpu": { "nvidia-rtx-4060": 100, "nvidia-rtx-5070": "<score>" },
    "cpu": { "amd-ryzen-5-7600": 100, "amd-ryzen-7-9800x3d": "<score>" }
  },
  "runs": { "nvidia-rtx-4060": 4072 }
}
```

- Keys in `scores` are chip-level registry keys in `gpus.json` or `cpus.json`.
- **Board-partner cards:** `gpus.json` holds about 42 partner entries (e.g. `msi-rtx-5060-ti-shadow-2x-oc-plus-8gb`) with no link to their chip. Add an optional `chip` field holding the chip's registry key (`nvidia-rtx-5060-ti-8gb`). Lookup is `scores[entry.chip ?? key]`.
- **VRAM variants:** when the source can't tell them apart (Blender), the importer gives both chip keys the same score and lists them in the dataset's `method`.
- `npm run validate:data` checks that every score key and `chip` exists in the right registry file, each baseline scores exactly 100, scores are positive, and `metric` is one of the known values.

## Rendering importer

`scripts/import-blender-benchmarks.ts <snapshot.zip>` is run by hand when a new Blender version has enough runs. It's never run in CI and never downloads anything itself.

1. Stream the JSONL from the zip and keep runs of one pinned Blender version.
2. GPUs: keep each vendor's fastest backend. CPUs: keep `CPU` runs with a single CPU socket.
3. Map device names to registry keys through registry aliases, plus a small checked-in map for names that don't match.
4. For each part and scene: the median samples per minute, only with at least 20 runs. A part's score is the geometric mean over the three scenes, normalised to its category's baseline.
5. Write the dataset file and print the device names it couldn't map, so coverage gaps are visible.

The median resists outlier runs (overclocks, throttled laptops), and the geometric mean is the standard way to combine ratios.

## `list_models` contract

### New inputs

```ts
performance: z
  .enum(["rendering"]) // gaming values are added when a gaming dataset exists
  .optional()
  .describe("Add benchmark scores for this workload and rank by them. GPU or CPU only. Rendering scores say nothing about gaming."),
model_ids: z
  .array(z.string())
  .min(2)
  .max(5)
  .optional()
  .describe("Compare these finalists only: model_id values from an earlier list_models result.")
```

- `performance` needs `category` set to `gpu` or `cpu`; anything else returns an error with a hint, like other invalid filters.
- `model_ids` reuses `matchesModelId` (`src/lib/catalog/model-aggregator.ts`), which `search_products` already uses for its `model_id` filter.

### New outputs (only when `performance` is set)

Each model gets:

```ts
perf: {
  score: number;          // the dataset's index, baseline = 100
  vs_leader_pct: number;  // 100 * (score / leader_score - 1); 0 for the leader, negative for the others
  per_1k: number | null;  // score per 1,000 units of the local currency at price_range.min; null without a price
} | null                  // null: no score in this dataset
```

The result gets one `perf_info` block, rather than repeating provenance on every row:

```ts
perf_info: {
  metric: "rendering";
  dataset: string;        // e.g. "blender-5.2-rendering"
  source: string;         // "Blender Open Data (CC0), snapshot 2026-10-31"
  baseline: string;       // registry key scoring 100
  leader: string | null;  // model_id with the top score
  scored: number;
  unscored: number;       // counted over all matching models, before the limit
}
```

When `unscored > 0`, the hint says so and warns against calling the top scored model the fastest.

### Ranking

- Scored models sort by score, highest first. Unscored models follow in today's order (lowest price first). The leader and percentages are computed over every matching model, before the limit.
- This uses the existing path in `runListModels` that fetches every matching model, filters, then applies the limit (`hasToolFilters`, `src/lib/tools/list-models.ts`). At current catalog sizes that's cheap; materialise scores only if a measurement says it's needed.
- Without `performance`, `list_models` behaves exactly as today.

## Prompt changes

- `src/lib/llm/chat-engine.ts:111`, the `list_models → search_products` line: for rendering or 3D work, pass `performance: "rendering"`, and compare finalists with `model_ids`. There are no gaming scores yet, so don't use rendering scores to rank gaming parts.
- `chat-engine.ts:116` already forbids "fastest" claims without data, so it stays.
- The voice backend and the MCP server pick up the new inputs through `createToolRegistry`; no separate change.

## Phases

1. **Data contract.** Add `benchmark.schema.json`, the `chip` field on partner GPU entries, and the new `validate:data` checks.
2. **Importer and first dataset.** Write the importer, run it on a current snapshot, and commit `blender-<version>-rendering.json` with its list of unmapped devices.
3. **`list_models`.** Add the inputs, outputs and ranking above, with tests:
   - Missing scores.
   - The leader and percentage maths.
   - `per_1k` is null without a price.
   - Unscored models come last and are counted.
   - The `model_ids` filter.
   - The category guard.
   - The top-scoring model ranks first even when it lies beyond the default limit of 20.
4. **Prompt and evaluation.** Update the prompt line and run three chats on a local model (Ornith): a creator build that uses rendering scores, a gaming build that doesn't use them, and a comparison of finalists.
5. **Gaming dataset.** Once a source is settled: the same format, new metric values and the matching prompt change.

Phases 1 and 2 must land before phase 3 can show real scores, but phase 3 can be built against a test fixture in parallel.

## Acceptance criteria

- `npm run validate:data` passes, and every score traces to a dataset file with source, licence and method.
- Missing scores never throw, never filter a model out and never block `validate_build`. Unscored models are sorted last and counted in `perf_info`.
- The top-scoring model ranks first even when it lies beyond the default limit.
- `list_models` makes no network calls for scores.
- Existing `list_models` tests pass unchanged, so behaviour without `performance` is identical.
- In the evaluation chats, the model doesn't use rendering scores to rank gaming parts.

## Open decisions

1. **Gaming source:** ask for a licence, enter scores by hand from cited reviews, or wait (see [Gaming: open decision](#gaming-open-decision)).
2. **Re-import cadence:** proposed on each new Blender release once its baseline parts have at least 20 runs per scene; manual.
3. **CPU/GPU balance advice:** deferred. It may come back only with evidence-backed, resolution-specific pairing data.

## What changed from the 13 Sep plan

- **Tool surface:** dropped the `compare_components` tool and the `search_products` performance sort. `list_models` didn't exist when the plan was written. It now does the model-level ranking, and its `model_ids` filter covers comparing finalists, with the same arithmetic.
- **Provenance:** moved from every registry metric into one file per dataset.
- **Data source:** named Blender Open Data for rendering; gaming is an explicit open decision instead of "curated scores".
- **Board-partner cards:** added the `chip` link they need, since the registry now holds about 42 of them.
- **Dropped details:** `perf_*` keys in compact specs, `resolution` and `workload` inputs on `search_products`, and the `all` metric option. The missing-data, no-web-research and no-CPU/GPU-cross-comparison rules are kept.
