# Plan: benchmark scores in `list_models`

> **Status:** phases 1–4 (rendering scores) are built in #67. Phase 5 (gaming) waits on a data source.
> **History:** first written 13 Sep 2026. Reworked 31 Oct 2026 against current master: it now names a data source, uses `list_models` instead of a new tool, and stores provenance once per dataset. See [What changed from the 13 Sep plan](#what-changed-from-the-13-sep-plan).

## Problem

Models don't know parts released after their training cutoff (RTX 50-series, RX 9000-series, Ryzen 9000, Core Ultra 200). They guess performance tiers, and they can't say how much faster one shortlisted part is or what it costs per unit of performance. PCBuildSage should answer that from local, cited data, and say plainly when it has none.

## Decisions

| Area | Decision | Why |
| :--- | :--- | :--- |
| Unit of scoring | One score per **chip** (e.g. `nvidia-rtx-5060-ti-8gb`), not per board-partner card. | Partner cards of one chip perform within a few percent; benchmarks report chips. |
| Scale | Relative index, baseline = 100. GPU baseline `nvidia-rtx-4060`, CPU baseline `amd-ryzen-5-7600`. | Linear and easy to read; both baselines are common current parts. |
| Metrics | `rendering` (CPU and GPU) now. `gaming_1080p`, `gaming_1440p`, `gaming_4k` (GPU) and `gaming` (CPU) are reserved until a gaming source is settled. | Only rendering has an openly licensed source today (see [Data sources](#data-sources)). |
| Separation | A score is only compared with scores of the same metric from the same dataset. Rendering scores never answer a gaming question. | In Blender the RX 9070 XT scores only 13% above an RTX 4060, yet in games it's in a much higher class. Mixing metrics would mislead. |
| Provenance | Stored once per dataset file (source, licence, snapshot date, method, baseline), not on every registry entry. | The 13 Sep plan repeated baseline, dataset, source and date on every metric of every part. |
| Missing data | A part without a score gets `perf: null`. It is never filtered out, never blocks validation, and never triggers web research. | Scores are optional enrichment. |
| Tool surface | Extend `list_models`. No new tool, and no changes to `search_products`, `validate_build` or `present_build`. | `list_models` already returns one row per model with its price range, and the prompt already sends the model there before `search_products`. Each tool adds context to every chat turn and MCP session, which matters for small local models. Decided 31 Oct. |
| CPU/GPU balance | Deferred, unchanged from the 13 Sep plan. | No evidence-backed pairing rules yet; CPU and GPU indices are never compared with each other. |

## Data sources

### Rendering: Blender Open Data (chosen)

- **Licence:** CC0 (public domain), stated on <https://opendata.blender.org/download/> and in the archive's `LICENSE.txt`. Confirmed 31 Oct 2026.
- **What it is:** a daily snapshot (about 100 MB zipped, 1.9 GB JSONL) of Blender Benchmark runs uploaded by users: Blender version, scene, device, backend (OptiX, CUDA, HIP, oneAPI, Metal, CPU) and samples per minute.
- **Coverage of the first dataset** (31 Oct snapshot, Blender 5.2 only, desktop parts only): 33,066 runs give scores for 47 GPU and 48 CPU chips. A sample, with the fewest runs behind any one scene:

  | Part | Backend | Score | Runs |
  | :--- | :--- | ---: | ---: |
  | RTX 4060 (baseline) | OptiX | 100 | 67 |
  | RTX 5060 | OptiX | 124 | 103 |
  | RTX 5060 Ti | OptiX | 139 | 219 |
  | RTX 5070 | OptiX | 195 | 174 |
  | RX 9060 XT | HIP | 56 | 62 |
  | RX 9070 XT | HIP | 113 | 409 |
  | Arc B580 | oneAPI | 95 | 22 |
  | Ryzen 5 7600 (baseline) | CPU | 100 | 14 |
  | Ryzen 7 9800X3D | CPU | 175 | 202 |
  | Core i5-14400F | CPU | 100 | 11 |
  | Core Ultra 7 265K | CPU | 230 | 27 |

  An earlier count here mixed Blender 4.2–5.2 and matched laptop GPUs too (e.g. 4,072 RTX 4060 runs); one release and desktop chips leave far fewer. That's why the minimum is 10 runs per scene, not 20: at 20 the CPU baseline itself drops out.
- **Noise:** runs are user-submitted. Between Blender 5.1 and 5.2 the same chips moved by a median 2.6% for GPUs (90th percentile 7%) and 6.3% for CPUs (90th percentile 13.6%); AMD GPUs on HIP move the most. So results say to treat gaps under 10% as a tie.
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
  "method": "Blender 5.2.x; scenes monster, junkshop, classroom; median samples per minute per scene over at least 10 runs; geometric mean of the scenes. …",
  "baselines": { "gpu": "nvidia-rtx-4060", "cpu": "amd-ryzen-5-7600" },
  "scores": {
    "gpu": { "nvidia-rtx-4060": 100, "nvidia-rtx-5070": 195 },
    "cpu": { "amd-ryzen-5-7600": 100, "amd-ryzen-7-9800x3d": 175 }
  },
  "runs": { "nvidia-rtx-4060": 67, "nvidia-rtx-5070": 174 }
}
```

Scores are whole numbers: the noise above makes decimals meaningless. `runs` holds, per scored key, the fewest runs behind any one scene's median.

- Keys in `scores` are chip-level registry keys in `gpus.json` or `cpus.json`.
- **Board-partner cards:** `gpus.json` holds about 42 partner entries (e.g. `msi-rtx-5060-ti-shadow-2x-oc-plus-8gb`) with no link to their chip. Add an optional `chip` field holding the chip's registry key (`nvidia-rtx-5060-ti-8gb`). Lookup is `scores[entry.chip ?? key]`.
- **VRAM variants:** Blender can't tell them apart. Where variants share a die and memory bus and differ only in VRAM (RTX 5060 Ti, RTX 4060 Ti, RX 9060 XT, Arc A770), both keys get the same score, listed in the dataset's `method`. Other same-name pairs differ in cores or bus width (RTX 3050 6/8 GB, RTX 3060 8/12 GB, RTX 3080 10/12 GB, RTX 2060 6/12 GB), so they stay unscored rather than guessed.
- `npm run validate:data` checks the schema, one dataset per metric, that each baseline scores exactly 100, that every score key exists in the right registry file and isn't a partner card, that `runs` covers the same keys as `scores`, and that each `chip` points to a chip entry.

## Rendering importer

`scripts/import-blender-benchmarks.ts` is run by hand when a new Blender version has enough runs. It's never run in CI and never downloads anything itself:

```sh
unzip -p opendata-latest.zip '*.jsonl' | npm run -s import-blender-benchmarks -- --blender 5.2 --snapshot 2026-10-31
```

1. Read the JSONL from stdin and keep runs of one pinned Blender release.
2. GPUs: keep each vendor's fastest backend. CPUs: keep `CPU` runs with a single CPU socket.
3. Map device names to chip-level registry entries by exact chip name (vendor words and VRAM size stripped). Laptop parts never match a desktop chip, and partner cards are skipped.
4. For each part and scene: the median samples per minute, only with at least 10 runs (`--min-runs`). A part's score is the geometric mean over the three scenes, normalised to its category's baseline and rounded.
5. Write the dataset file and print the most-run device names it couldn't map, so coverage gaps are visible.

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

`model_ids` also accepts the list as a JSON string, like the tool's other array inputs, since small models often send one.

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
  note: string;           // "treat gaps under 10% as a tie"; for rendering, "says nothing about gaming"
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
- Phase 4 checked this with three chats on Ornith (see #67). The Blender build ranked GPUs and CPUs with `performance: "rendering"`; the gaming build never used it; the 5060 Ti vs 5070 comparison used `model_ids` and quoted the scores correctly. One call passed `search_products` product ids as `model_ids`, so an empty `model_ids` match now says which ids it expects.
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
2. **Re-import cadence:** proposed on each new Blender release once its baseline parts have at least 10 runs per scene; manual. Scores from different releases are never mixed.
3. **CPU/GPU balance advice:** deferred. It may come back only with evidence-backed, resolution-specific pairing data.

## What changed from the 13 Sep plan

- **Tool surface:** dropped the `compare_components` tool and the `search_products` performance sort. `list_models` didn't exist when the plan was written. It now does the model-level ranking, and its `model_ids` filter covers comparing finalists, with the same arithmetic.
- **Provenance:** moved from every registry metric into one file per dataset.
- **Data source:** named Blender Open Data for rendering; gaming is an explicit open decision instead of "curated scores".
- **Board-partner cards:** added the `chip` link they need, since the registry now holds about 42 of them.
- **Dropped details:** `perf_*` keys in compact specs, `resolution` and `workload` inputs on `search_products`, and the `all` metric option. The missing-data, no-web-research and no-CPU/GPU-cross-comparison rules are kept.
