# Implementation Plan: Component Benchmarks & Relative Performance Ranks

> **Status:** Specification & Planning Phase — **Implementation has not started.**  
> **Author / Architect:** Manish Modak & Pair AI  
> **Target PR:** Draft / Architecture Spec  

---

## 1. Executive Summary & Problem Statement

LLMs evaluating PC components are constrained by training knowledge cutoffs. When evaluating newer components (e.g., NVIDIA RTX 50-series, AMD Ryzen 9000-series, Intel Core Ultra 200) or comparing parts across differing architecture generations, models frequently hallucinate relative performance tiers, misjudge bottleneck risks, or struggle to calculate price-to-performance tradeoffs.

This plan specifies a deterministic, local-first benchmark ranking subsystem integrated into PCBuildSage. It provides:
1. **Curated relative performance indices** in the offline component registry (`data/registry/`).
2. **Passive enrichment & optional performance sorting** in the existing `search_products` tool.
3. **A dedicated `compare_components` tool** for side-by-side delta and price-to-performance calculations.
4. **Strict missing-data and research guards**: benchmarks are optional; missing data returns `unset`/`unavailable` and **never blocks** recommendations or validation.

---

## 2. Agreed Design Decisions

| Decision Area | Agreed Choice | Rationale |
| :--- | :--- | :--- |
| **Scoring Scale** | Relative performance index with fixed baseline = 100 (scores can exceed 100). | Intuitive, linear, and matches established hardware aggregation hierarchies (TechPowerUp, Tom's Hardware). |
| **GPU Baseline** | `NVIDIA GeForce RTX 4060 8GB` = 100. | Modern, ubiquitous, mid-range 1080p/1440p anchor. |
| **CPU Baseline** | `AMD Ryzen 5 7600` = 100. | Modern, ubiquitous, 6-core AM5 gaming/productivity anchor. |
| **Metric Separation** | GPUs by resolution (`p1080`, `p1440`, `p2160`); CPUs by workload (`gaming`, `multicore`, `single_core`). | Prevents deceptive cross-workload conflation (e.g., high core count does not equal high FPS). |
| **Provenance** | Each metric includes `baseline`, `dataset_id`, `source`, and `benchmark_date`. | A fixed baseline alone does not establish comparability; datasets identify a frozen suite, settings, and test methodology. |
| **Missing Data** | Return `unset` / `unavailable`. Never hallucinate or synthesize estimated numbers. | Preserves absolute trust in the system's output. |
| **Comparison / Research Budget** | One comparison of 2–3 candidates by default; at most one justified follow-up and one targeted benchmark research call per build request. Enforced across turns by the runtime. | Bounds latency and tool use; missing data alone never triggers research. |
| **Tool Surface** | **Hybrid**: Passive `perf_score` + optional `sort_by: "perf"` in `search_products`; new dedicated `compare_components` tool. | Gives instant context during search, and detailed arithmetic during explicit comparisons. |
| **Build Validation** | **Deferred**: CPU/GPU balance advice is non-blocking and deferred until workload-specific, evidence-backed rules exist. | Avoids ungrounded heuristics or comparing CPU and GPU scores directly. |

---

## 3. Scope & Non-Goals

### In Scope
- Schema additions to `data/schemas/registry.schema.json`.
- Seed a small verified set in `data/registry/gpus.json` and `data/registry/cpus.json`; extend generation coverage incrementally as comparable sources become available.
- Propagating benchmark metrics through `src/lib/catalog/compact.ts` into `FUNCTIONAL_SPEC_KEYS`.
- Adding optional `sort_by: "perf"` with mandatory resolution/workload context to `search_products`.
- Creating `src/lib/tools/compare-components.ts` and registering it in `src/lib/tools/index.ts`.
- Value ratio (performance per unit price) computation when both catalog prices and comparable benchmarks exist.
- Unit and integration tests covering schema validation, tool execution, and edge-case handling.

### Non-Goals
- **No automatic web research for missing benchmarks**: missing benchmarks will not trigger background crawls or external API calls.
- **No synthetic benchmarking or simulation engine**: PCBuildSage will not calculate theoretical FLOPS, clock math, or simulated FPS.
- **No CPU/GPU cross-index math**: CPU and GPU performance indices will never be compared directly against each other.
- **No benchmark-based exclusion**: missing scores do not affect search eligibility or build validity; normal stock, compatibility, and user constraints still apply.

---

## 4. Proposed Contracts & Schemas

### 4.1. Registry Schema (`data/schemas/registry.schema.json`)

The optional `benchmarks` property maps category-appropriate metrics to records. A missing metric is omitted in the registry and returned as `null` by tools. Use these logical types to implement the JSON schema in the existing registry schema structure:

```ts
type GpuMetric = "p1080" | "p1440" | "p2160";
type CpuMetric = "gaming" | "multicore" | "single_core";
interface BenchmarkMetric {
  score: number; // finite, strictly positive; baseline is 100
  baseline: string; // canonical registry key for the reference component
  dataset_id: string; // immutable comparison group, including metric/methodology revision
  source: string; // exact source URL or versioned source artifact
  benchmark_date: string; // YYYY-MM-DD: source measurement/publication date
}
type GpuBenchmarks = Partial<Record<GpuMetric, BenchmarkMetric>>;
type CpuBenchmarks = Partial<Record<CpuMetric, BenchmarkMetric>>;
```

Schema validation rejects wrong-category metric keys, non-positive scores, unknown record properties, and malformed dates. A present benchmark map must contain at least one metric. Keep `benchmarks` optional so existing registry entries remain valid.

Each dataset must document its suite/version, aggregation and normalization formula, test platform, settings, and reference measurement. GPU indices describe raster gaming at the named resolution; CPU gaming, multicore, and single-core indices each identify a specific suite. Cinebench and Blender results cannot be interchanged under one generic metric. Calculate `100 * measured_result / baseline_result` only for higher-is-better measurements within the same dataset; unsupported measurement types remain unset.

Two scores are comparable only when category, metric, baseline, and `dataset_id` match. Matching publisher names, baseline names, or dates alone is insufficient. Changing suite composition or methodology creates a new dataset; retain provenance per metric. Start with one curated active dataset per category/metric, documented alongside seed data. Search uses that dataset consistently; do not combine unrelated review indices to fill coverage gaps.

### 4.2. Compact Spec Whitelist (`src/lib/catalog/compact.ts`)

- `perf_score`: selected context's score, or null when unavailable.
- `perf_metric`: the selected metric, returned alongside the score.
- `perf_provenance`: baseline, dataset ID, source, and benchmark date for that score.

When search supplies resolution/workload, use that context even if sorting by price. For ordinary searches without context, omit performance enrichment rather than silently selecting 1440p/gaming. Comparison reads full metric records from the registry directly; ordinary search does not need to return the entire benchmark map for every product. Whitelisting alone does not derive these fields: explicitly project them from the resolved registry record before compaction.

### 4.3. `search_products` Tool Contract Updates

#### Input Schema additions:
```ts
sort_by: z
  .enum(["price", "name", "retailer", "last_scraped", "perf"])
  .default("price")
  .describe("Sort field. Use 'perf' to rank by performance (requires 'resolution' for GPUs or 'workload' for CPUs)."),
resolution: z
  .enum(["1080p", "1440p", "4k"])
  .optional()
  .describe("Target resolution context when sorting GPUs by performance."),
workload: z
  .enum(["gaming", "multicore", "single_core"])
  .optional()
  .describe("Target workload context when sorting CPUs by performance.")
```

#### Output behavior when `sort_by === "perf"`:
1. Validates that `category` is `"gpu"` or `"cpu"`, and matching `resolution`/`workload` is provided.
2. Sorts comparable scores descending by default for `perf`; honor an explicit `asc`. Keep existing defaults for other sorts. Use a stable product-ID tie-breaker.
3. Items lacking a score in the active comparison dataset are **not filtered out**; place them after comparable scored items in either direction. Treat incompatible datasets as unscored for ranking, with a diagnostic.
4. Response metadata includes:
   ```json
   {
     "benchmark_coverage": {
       "scored": 6,
       "unscored": 2,
       "metric": "p1440",
       "baseline": "<canonical RTX 4060 registry key>",
       "dataset_id": "<active p1440 dataset>",
       "scope": "all_matching_products_before_limit"
     }
   }
   ```

Coverage counts apply to the full eligible result set after market, stock, price, and spec filters, before limiting results. Unscored products remain eligible but may fall outside the returned page; the LLM must not describe the top scored result as definitively fastest when coverage is incomplete.

**Repository execution path:** benchmark scores currently come from registry resolution after SQL retrieval. The current scan may stop at `limit + 1` matches, so sorting that shortlist is incorrect. For the initial implementation, retain the existing path for non-performance sorts. For `perf`, scan all SQL-filtered candidates in batches, resolve specs and apply registry filters, project comparable scores, sort globally, then apply the result limit. Calculate coverage from that same eligible set. Do not add an SQL score sort unless scores are actually materialized there. Measure this path with the current catalog; a materialized score index is future optimization if needed. Test a highest-scoring match located beyond the first SQL batch.

### 4.4. `compare_components` Tool Contract

#### Input Schema:
```ts
export const compareComponentsInputSchema = z.object({
  parts: z
    .array(z.string())
    .min(2)
    .max(3)
    .describe("2 to 3 distinct component names or registry keys to compare (e.g. ['RTX 4070 Super', 'RTX 5070'] or ['Ryzen 5 7600', 'Ryzen 7 7800X3D'])."),
  category: z
    .enum(["cpu", "gpu"])
    .describe("Component category to compare. Comparisons must belong to the same category."),
  resolution: z
    .enum(["1080p", "1440p", "4k", "all"])
    .optional()
    .describe("For GPUs: required resolution; all only when explicitly requested by the user."),
  workload: z
    .enum(["gaming", "multicore", "single_core", "all"])
    .optional()
    .describe("For CPUs: required workload; all only when explicitly requested by the user.")
});
```

Validate the category-matching context and reject the wrong category's context. There is no implicit `all` default. Resolve aliases deterministically, then reject duplicate canonical keys. Ambiguous names return candidate identities without guessing a SKU. Unknown names return an unavailable component entry. Missing benchmark data is a successful result, not a retry signal.

#### Output Schema:
```ts
export interface ComponentComparisonResult {
  category: "cpu" | "gpu";
  status: "ok" | "budget_exhausted";
  components: Array<{
    name: string;
    registry_key: string | null;
    metrics: Record<string, {
      benchmark: BenchmarkMetric | null;
      value_ratio: number | null; // (score / price) * 1000, for this metric
    }>;
    offer: {
      product_id: string;
      price: number;
      currency: string;
      retailer: string;
      last_scraped: string;
    } | null;
  }>;
  comparisons: Array<{
    metric: string;
    dataset_id: string | null;
    leader: string | null;
    relative_deltas: Array<{
      component: string;
      delta_pct_vs_leader: number | null;
    }>;
    best_value: string | null;
  }>;
  warnings: string[];
}
```

Return only requested metrics. `delta_pct_vs_leader = 100 * (score / leader_score - 1)`; this expresses how far a part falls below the leader, not how much faster the leader is relative to that part. Pick leaders and best value only within the active comparable group; require at least two eligible components, otherwise return null. Preserve each metric's provenance even when comparison is unavailable. Retain precision for calculations and round only output values.

Select the lowest positive-priced, in-stock catalog offer for the exact resolved part in the active country/currency, breaking ties by newest scrape then product ID. Do not substitute a similar model, MSRP, or foreign-market offer. Return the offer identity, price and scrape time used. Value results require at least two comparable benchmarks with eligible same-currency offers; other entries remain null. Calculate and identify best value separately for each metric. A missing offer never blocks performance comparison.

---

## 5. Missing-Data & Research Boundaries

1. **Deterministic Resolution Only**:  
   `compare_components` resolves parts against `data/registry/` and active catalog products. It does not invoke search crawlers.
2. **Strict Non-Blocking Rule**:  
   If a component is unbenchmarked:
   - `metrics[metric].benchmark = null`
   - `warnings.push("Benchmark score for <part> is unavailable.")`
   - The tool succeeds and returns comparative data for the remaining parts.
3. **No Cross-Baseline Comparison**:  
   If two parts have benchmark scores from differing baselines or incompatible test suites, delta calculations return `null` with an explanatory notice identifying the actual baseline or dataset mismatch.
4. **Value Ratios**:  
   Follow the per-metric, comparable-group and offer-selection rules in §4.4. Never estimate prices from MSRP or foreign currencies.

### 5.1. Runtime comparison and research limits

- A **build request** is a user-started build/recommendation objective, identified by a server-owned request ID within the chat session. Carry counters across tool steps, follow-up messages, retries, and reconnects for that objective. A new message alone does not reset them. Reset only for an explicit new build/comparison objective; the model cannot mint a new ID to replenish its allowance.
- Allow one comparison of 2–3 distinct candidates by default. A second requires a structured reason identifying a material unresolved decision and referencing the first result. Missing data alone is insufficient. Carry that reason and prior-result ID as execution metadata, separate from the hardware input contract. The runtime validates their presence/reference and enforces a hard ceiling of two executions; prompt guidance determines whether the reason is substantively useful and must be evaluated with representative conversations.
- Allow at most one targeted **benchmark** research execution through `consult` for that objective, only if enabled and requested by the user or needed for a material unresolved choice. Mark benchmark research purpose explicitly and route it through the same budget guard. This budget does not alter existing compatibility/specification research behavior.
- Check and reserve allowance atomically before executing a call, including simultaneous calls. Count dispatched executions even if unsuccessful; reuse persisted results for duplicate calls or retried tool-call IDs without another execution. Cache by canonical parts, metric context, dataset revision, and market/offer snapshot; invalidate stale results without resetting counters.
- On exhaustion return a structured `budget_exhausted` result and reusable evidence. Do not retry, expand candidates, switch tools to evade the benchmark budget, or block the build. Explain remaining uncertainty and continue from available data.
- Search uses local enrichment and never consumes comparison allowance or triggers research. Do not make benchmarks a mandatory checklist for each component category. Stop once evidence supports the recommendation.

Implement request state and the execution guard at the server/tool boundary; instructions in `chat-engine.ts` alone are insufficient. Confirm the existing session persistence and tool execution plumbing before selecting storage, and record that choice in the implementation PR. Acceptance requires persistence across turns and atomic reservation; do not ship a per-invocation in-memory counter as an equivalent substitute.

---

## 6. Affected Files & Architecture Map

```
pcbuildsage/
├── data/
│   ├── schemas/
│   │   └── registry.schema.json              # [MODIFY] Add 'benchmarks' schema definition
│   └── registry/
│       ├── gpus.json                         # [MODIFY] Seed benchmark scores for major GPUs
│       └── cpus.json                         # [MODIFY] Seed benchmark scores for major CPUs
├── src/
│   ├── lib/
│   │   ├── catalog/
│   │   │   ├── compact.ts                    # [MODIFY] Add perf keys to FUNCTIONAL_SPEC_KEYS
│   │   │   ├── repository.ts                 # [MODIFY] Support perf sort in searchProducts
│   │   │   └── sql-repository.ts             # [MODIFY] Global registry-aware perf ranking before limit
│   │   ├── registry.ts                       # [MODIFY] Existing registry types and benchmark records
│   │   ├── llm/chat-engine.ts                # [MODIFY] Context and bounded comparison directives
│   │   └── tools/
│   │       ├── search-products.ts            # [MODIFY] Expose 'perf' in sort_by & coverage meta
│   │       ├── compare-components.ts         # [NEW] Dedicated comparison tool implementation
│   │       └── index.ts                      # [MODIFY] Register compare_components tool
│   └── app/api/chat/route.ts                 # [INSPECT/MODIFY] Carry server-owned request context
└── tests/                                   # Proposed tests; align with existing colocated conventions
    ├── tools/
    │   ├── compare-components.test.ts        # [NEW] Unit tests for comparison & delta arithmetic
    │   └── search-products-perf.test.ts      # [NEW] Tests for perf sorting & fallback behavior
    └── data/
        └── registry-schema.test.ts           # [VERIFY] Verify validate:data passes schema checks
```

---

## 7. Phased Implementation Tasks & Dependencies

```mermaid
graph TD
    T1[Task 1: Registry Schema & TypeScript Types] --> T2[Task 2: Seed Benchmark Data in cpus.json and gpus.json]
    T1 --> T3[Task 3: Catalog Projection & Compaction]
    T3 --> T4[Task 4: Implement compare_components Tool]
    T3 --> T5[Task 5: Add Performance Sorting to search_products]
    T1 --> T8[Task 8: Persistent Runtime Budget Guard]
    T4 --> T6[Task 6: Registration & LLM Guidance]
    T8 --> T6
    T2 --> T7
    T5 --> T6
    T6 --> T7[Task 7: Automated Integration Tests & CI Verification]
```

The runtime guard and request-state storage files must be identified during Task 1 by tracing `src/app/api/chat/route.ts`, `src/lib/llm/chat-engine.ts`, and tool registration. Add those exact paths to the implementation PR; they are required scope, not optional prompting work. The existing registry type file is `src/lib/registry.ts` (there is no `src/types/registry.ts`).

### Phase 1: Data Contracts & Seeding
- [ ] **Task 1: Schema Updates**
  - Update `data/schemas/registry.schema.json` with the `benchmarks` schema.
  - Update `src/lib/registry.ts` with per-metric benchmark types.
  - Define shared score projection, comparison-group selection, and budget-state contracts; identify persistence and execution-guard integration points.
- [ ] **Task 2: Seed Benchmarks**
  - Document immutable dataset definitions and normalization inputs. Start with a small verified set; broader generation coverage is incremental and not a prerequisite for tool development.
  - Seed baseline = 100 for `NVIDIA GeForce RTX 4060 8GB` (`gpus.json`) and `AMD Ryzen 5 7600` (`cpus.json`).
  - Populate verified relative scores for common modern GPUs (RTX 40/50-series, RX 7000-series) and CPUs (Ryzen 7000/9000, Intel 13th/14th Gen).
  - Run `npm run validate:data` to verify zero schema regressions.

### Phase 2: Catalog Integration & Comparison Engine
- [ ] **Task 3: Catalog Spec Propagation**
  - Project `perf_score`, `perf_metric`, and selected provenance from resolved registry metrics; add those keys to compaction. Leave no-context search unchanged.
- [ ] **Task 4: `compare_components` Tool**
  - Implement `src/lib/tools/compare-components.ts` with strict delta math, value ratios, and missing-data guards.
  - Add comprehensive unit tests in `tests/tools/compare-components.test.ts`.

### Phase 3: Search Sorting & LLM Prompting
- [ ] **Task 5: `search_products` Performance Sort**
  - Update `searchProductsInputSchema` to accept `sort_by: "perf"` with `resolution` or `workload`.
  - Implement global registry-aware ranking before limiting as specified in §4.3, with full eligible-set coverage and existing non-performance sort behavior preserved.
- [ ] **Task 6: Registration & LLM Directives**
  - Register `compare_components` in `src/lib/tools/index.ts`.
  - Update `src/lib/llm/chat-engine.ts` system directives advising the LLM on when to use `compare_components` vs `search_products`.

- [ ] **Task 8: Runtime Budget Guard**
  - Implement §5.1 request identity, persisted counters/results, atomic reservation, duplicate reuse, and graceful exhaustion at the execution boundary.
  - Integrate comparison and benchmark-purpose consult execution; verify compatibility research remains unaffected.

Tasks 2, 3, and 8 can proceed independently after Task 1 contracts are agreed, using fixtures. Tasks 4 and 5 can proceed in parallel after Task 3; Task 6 integrates both with Task 8. Verification includes real seed data from Task 2. Contributors should own separate modules and coordinate shared contract changes through Task 1.

### Phase 4: Verification & Hardening
- [ ] **Task 7: Comprehensive Verification**
  - Full test suite execution: `npm test` and `npm run typecheck`.
  - Edge case validation: unbenchmarked components, missing prices, identical models, single-component requests.

---

## 8. Acceptance Criteria

1. **Data Validity**:
   - `npm run validate:data` passes without any schema validation errors.
2. **Missing-Data Resilience**:
   - Querying or comparing parts with missing benchmark data returns `null` / `unavailable` and **never** throws an exception or halts conversation.
   - Missing benchmarks never prevent a part from being selected or validated in `validate_build`.
3. **Accuracy of Calculations**:
   - `compare_components` deltas accurately reflect mathematical percentage differences relative to the leader.
   - Value ratios are only computed when both catalog price and benchmark score are present and non-zero.
4. **Performance Sorting Integrity**:
   - `search_products` with `sort_by: "perf"` sorts highest performing parts first, places unbenchmarked parts at the bottom, and indicates coverage in the metadata.
5. **Comparable Data and Context**:
   - Same-baseline but different-dataset scores never participate in shared ranking/deltas/value winners.
   - Search scores identify the requested metric; missing context never silently selects a different workload. Comparison requires context, and `all` is explicit.
   - Each returned metric retains its own provenance; value ratios are metric-specific and use eligible same-currency catalog offers.
6. **Bounded Tool Use**:
   - Multiple turns/reconnects for one objective retain counters; the third distinct comparison is denied and the second requires a reason/reference.
   - Duplicate/retried and simultaneous calls cannot bypass the cap; benchmark research is limited to one execution, without changing compatibility research rules.
   - Missing data and budget exhaustion produce a useful response without loops or blocking a recommendation.
7. **Global Ranking**:
   - A best-scoring candidate beyond the first SQL batch still ranks first before limit; both explicit sort directions put unscored entries last.
   - Coverage describes all eligible matches, including unreturned unscored entries. Existing non-performance search behavior remains intact.
8. **Zero Web Bloat**:
   - No benchmark comparison initiates network requests or web search unless explicitly requested through the separate `consult` workflow.

---

## 9. Unresolved Decisions & Future Work

- **CPU/GPU Bottleneck & Balance Heuristics**:
  - *Status:* **Deferred.**
  - Direct mathematical comparison between CPU and GPU scores was rejected as ungrounded.
  - Future implementation may introduce an advisory rule in `validate_build` only when evidence-backed, resolution-specific pairing matrices (e.g. minimum CPU gaming index recommended for tier of GPU at 1080p vs 4K) are compiled from empirical reviews.

- **Implementation checkpoints (not permission to omit requirements):**
  - Choose the initial source suites and verify reference coverage before seeding; do not invent scores to meet generation targets.
  - Identify existing session persistence and add server-owned build-request budget state with cross-turn atomic updates. Document exact affected files before implementing the guard.
  - Assess full-candidate performance sorting against the current catalog size. Add materialization only if measured cost warrants it.
