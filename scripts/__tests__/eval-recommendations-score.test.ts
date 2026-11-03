import { describe, expect, it } from "vitest";
import type { AskTurn, PresentedBuild } from "../../src/cli/ask-turn";
import type { BuildSnapshot, BuildSnapshotComponent } from "../../src/lib/catalog/build-snapshot";
import { formatScorecard, scoreBuild, scoreCase, type CatalogRow, type EvalCase } from "../eval-recommendations-score";

const PARTS: Array<[string, string, number]> = [
  ["gpu", "MSI GeForce RTX 5060 Ventus 2X 8GB", 30000],
  ["cpu", "AMD Ryzen 5 7600 Processor", 17000],
  ["motherboard", "MSI PRO B650M-A WiFi", 14000],
  ["ram", "Corsair Vengeance 32GB (2x16GB) DDR5 6000MHz", 9000],
  ["storage", "WD Blue SN580 1TB NVMe SSD", 6000],
  ["psu", "Corsair CX650 650W 80+ Bronze", 5000],
  ["case", "Ant Esports ICE-112 Mid Tower", 3000]
];

const catalog = new Map<string, CatalogRow>(PARTS.map(([category, name]) => [`id-${category}`, { id: `id-${category}`, category, name, in_stock: true }]));
const lookup = (id: string) => catalog.get(id);

function component(category: string, name: string, price: number): BuildSnapshotComponent {
  return { category, product_id: `id-${category}`, name, price, currency: "INR", included: false };
}

/** A valid, in-stock, fully priced build; overrides adjust one thing per test. */
function build(opts: { drop?: string[]; components?: BuildSnapshotComponent[]; snapshot?: Partial<BuildSnapshot> } = {}): PresentedBuild {
  const components = opts.components ?? PARTS.filter(([category]) => !opts.drop?.includes(category)).map(([c, n, p]) => component(c, n, p));
  const total = components.reduce((sum, c) => sum + (c.price ?? 0), 0);
  const snapshot: BuildSnapshot = {
    label: "Within budget",
    components,
    total,
    subtotal: total,
    currency: "INR",
    is_complete: true,
    component_count: components.length,
    unpriced_count: 0,
    missing_prices: [],
    currencies: ["INR"],
    parts: {},
    valid: true,
    validation_summary: { passed: 10, failed: 0, unverified: 0, skipped: 0, issues: [] },
    created_at: "2026-11-03T00:00:00Z",
    ...opts.snapshot
  };
  return { label: "Within budget", snapshot };
}

const baseCase: EvalCase = { id: "gaming-90k", prompt: "Gaming PC", budget: 90000, gpu: "required" };

describe("scoreBuild", () => {
  it("passes a valid in-stock build within budget", () => {
    const score = scoreBuild(build(), baseCase, lookup);
    expect(score).toMatchObject({ passed: true, failures: [], total: 84000, budgetUsedPct: 93.3 });
  });

  it("fails a build over budget", () => {
    const score = scoreBuild(build(), { ...baseCase, budget: 80000 }, lookup);
    expect(score.passed).toBe(false);
    expect(score.failures).toEqual(["total 84000 is over the 80000 budget"]);
  });

  it("fails a build without a complete total", () => {
    expect(scoreBuild(build({ snapshot: { total: null } }), baseCase, lookup).failures).toEqual(["build has no complete total"]);
  });

  it("fails out-of-stock, unknown and miscategorised parts", () => {
    const outOfStock = new Map(catalog);
    outOfStock.set("id-psu", { ...catalog.get("id-psu")!, in_stock: false });
    outOfStock.set("id-case", { ...catalog.get("id-case")!, category: "cooler" });
    outOfStock.delete("id-ram");
    const score = scoreBuild(build(), baseCase, (id) => outOfStock.get(id));
    expect(score.failures).toEqual([
      "ram is not a catalog product",
      'psu "Corsair CX650 650W 80+ Bronze" is out of stock',
      'case "Ant Esports ICE-112 Mid Tower" is a cooler in the catalog'
    ]);
  });

  it("never puts the model's own part names into failures", () => {
    const components = build().snapshot!.components.map((c) => (c.category === "case" ? { ...c, product_id: undefined, name: "MODEL TEXT RGB case" } : c));
    const score = scoreBuild(build({ components }), { ...baseCase, checks: { nameExcludes: "rgb", nameMatches: { case: "tower" } } }, lookup);
    expect(score.failures).toEqual(["case is not a catalog product", 'case "unknown part" does not match /tower/']);
  });

  it("skips the catalog check for an included stock cooler", () => {
    const parts = build().snapshot!.components;
    const cooler: BuildSnapshotComponent = { category: "cooler", name: "Stock Cooler (Included with CPU)", price: 0, currency: "INR", included: true };
    expect(scoreBuild(build({ components: [...parts, cooler] }), baseCase, lookup).passed).toBe(true);
  });

  it("fails a build missing a core part", () => {
    expect(scoreBuild(build({ drop: ["psu", "storage"] }), baseCase, lookup).failures).toEqual(["missing core parts: storage, psu"]);
  });

  it("applies the GPU rule for required, none and optional", () => {
    expect(scoreBuild(build({ drop: ["gpu"] }), baseCase, lookup).failures).toEqual(["GPU required but none in the build"]);
    expect(scoreBuild(build(), { ...baseCase, gpu: "none" }, lookup).failures).toEqual(["GPU excluded but the build has one"]);
    expect(scoreBuild(build({ drop: ["gpu"] }), { ...baseCase, gpu: "optional" }, lookup).passed).toBe(true);
    expect(scoreBuild(build(), { ...baseCase, gpu: "optional" }, lookup).passed).toBe(true);
  });

  it("fails invalid snapshots and failed checks", () => {
    expect(scoreBuild(build({ snapshot: { valid: false } }), baseCase, lookup).failures).toEqual(["snapshot is not valid"]);
    const failed = build({ snapshot: { validation_summary: { passed: 9, failed: 1, unverified: 0, skipped: 0, issues: [] } } });
    expect(scoreBuild(failed, baseCase, lookup).failures).toEqual(["1 compatibility check(s) failed"]);
    expect(scoreBuild({ label: "x" }, baseCase, lookup).failures).toEqual(["no validated snapshot for this build"]);
  });

  it("warns, without failing, on low budget use and unverified specs", () => {
    const score = scoreBuild(build({ snapshot: { validation_summary: { passed: 8, failed: 0, unverified: 2, skipped: 0, issues: [] } } }), { ...baseCase, budget: 150000 }, lookup);
    expect(score.passed).toBe(true);
    expect(score.warnings).toEqual(["uses only 56% of the budget", "2 unverified spec check(s)"]);
  });

  it("checks nameMatches per category, case-insensitively", () => {
    const itx: EvalCase = { ...baseCase, checks: { nameMatches: { motherboard: "itx" } } };
    expect(scoreBuild(build(), itx, lookup).failures).toEqual(['motherboard "MSI PRO B650M-A WiFi" does not match /itx/']);
    const amd: EvalCase = { ...baseCase, checks: { nameMatches: { cpu: "ryzen", gpu: "radeon|\\brx\\s?\\d" } } };
    expect(scoreBuild(build(), amd, lookup).failures).toEqual(['gpu "MSI GeForce RTX 5060 Ventus 2X 8GB" does not match /radeon|\\brx\\s?\\d/']);
    expect(scoreBuild(build({ drop: ["gpu"] }), { ...amd, gpu: "optional" }, lookup).failures).toEqual(["no gpu to match /radeon|\\brx\\s?\\d/"]);
  });

  it("checks nameExcludes across all parts", () => {
    const noRgb: EvalCase = { ...baseCase, checks: { nameExcludes: "\\bA?RGB\\b" } };
    expect(scoreBuild(build(), noRgb, lookup).passed).toBe(true);
    const argbCatalog = new Map(catalog).set("id-case", { ...catalog.get("id-case")!, name: "Ant Esports ICE-112 ARGB Mid Tower" });
    expect(scoreBuild(build(), noRgb, (id) => argbCatalog.get(id)).failures).toEqual(['case "Ant Esports ICE-112 ARGB Mid Tower" matches excluded /\\bA?RGB\\b/']);
  });

  it("sums RAM capacity from titles for minRamGb", () => {
    const needs64: EvalCase = { ...baseCase, checks: { minRamGb: 64 } };
    expect(scoreBuild(build(), needs64, lookup).failures).toEqual(["RAM is 32 GB, below 64 GB"]);
    const twoKits = [...build().snapshot!.components, component("ram", "Corsair Vengeance 32GB (2x16GB) DDR5 6000MHz", 9000)];
    expect(scoreBuild(build({ components: twoKits }), { ...needs64, budget: 100000 }, lookup).passed).toBe(true);
  });
});

describe("scoreCase", () => {
  const turn = (builds: PresentedBuild[], extra: Partial<AskTurn> = {}): AskTurn => ({ content: "", steps: 9, builds, ...extra });

  it("passes when any presented build passes", () => {
    const score = scoreCase({ ...baseCase, budget: 84000 }, turn([build({ drop: ["gpu"] }), build()]), lookup, 1200);
    expect(score).toMatchObject({ passed: true, turnFailures: [], steps: 9, wallMs: 1200 });
    expect(score.builds.map((b) => b.passed)).toEqual([false, true]);
  });

  it("names the kind of turn error without its raw text", () => {
    const failed = turn([], { streamError: "429 Too Many Requests: model said X" });
    expect(scoreCase(baseCase, failed, lookup, 500)).toMatchObject({ passed: false, turnFailures: ["no build presented", "provider error"] });
    expect(scoreCase(baseCase, failed, lookup, 500, true).turnFailures).toEqual(["no build presented", "timed out"]);
  });
});

describe("formatScorecard", () => {
  it("shows scores without build labels or model text", () => {
    const pass = scoreCase(baseCase, turn([build()]), lookup, 61000);
    const fail = scoreCase({ ...baseCase, id: "tight-50k", budget: 50000 }, turn([build()]), lookup, 2000);
    const md = formatScorecard([pass, fail], { model: "m", catalog: "catalog.db", date: "2026-11-03" });
    expect(md).toContain("# Recommendation eval: 1/2 cases pass");
    expect(md).toContain("| gaming-90k | pass | 1/1 | 84,000 / 90,000 (93.3%) | 0 | 9 | 61s | – |");
    expect(md).toContain("| tight-50k | **fail** | 0/1 | 84,000 / 50,000 (168%) | 0 | 9 | 2s | total 84000 is over the 50000 budget |");
    expect(md).not.toContain("Within budget");
  });

  function turn(builds: PresentedBuild[]): AskTurn {
    return { content: "model text", steps: 9, builds };
  }
});
