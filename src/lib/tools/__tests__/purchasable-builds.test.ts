import { describe, expect, it } from "vitest";
import { createBuildSnapshot, type BuildSnapshot } from "../../catalog/build-snapshot";
import type { ValidationResult } from "../../rules-engine";
import { hasSuccessfulValidation } from "../../llm/turn-policy";
import { derivedBuildFromSnapshot } from "@/features/chat/build-derive";
import { createPresentBuildTool } from "../present-build";
import { createTurnValidationStore, recordValidation } from "../turn-state";
import { notPurchasableNote, partMatchTerms, unpurchasableParts } from "../validate-build";

const validation = { valid: true, issues: [], resolved: {}, checks: [], summary: { passed: 1, failed: 0, unverified: 0, text: "" } } as unknown as ValidationResult;
const scope = { countryCode: "IN", currency: "INR" };
const cpu = { id: "cpu-1", name: "AMD Ryzen 5 7600", category: "cpu", price: 17000, currency: "INR", retailer: "Shop", in_stock: true };

function snapshotOf(parts: Record<string, unknown>): BuildSnapshot {
  return createBuildSnapshot({
    label: "Within budget",
    parts: parts as never,
    validation,
    productsById: new Map([[cpu.id, cpu as never]]),
    scope
  });
}

describe("owned parts", () => {
  it("are priced at 0 and keep the total complete", () => {
    const snap = snapshotOf({ cpu: { product_id: "cpu-1" }, gpu: { name: "RTX 3070", owned: true } });
    expect(snap.components.find((c) => c.category === "gpu")).toMatchObject({ name: "RTX 3070", price: 0, owned: true });
    expect(snap.total).toBe(17000);
  });

  it("render as 'already owned' rows on the card, not as missing catalog parts", () => {
    const snap = snapshotOf({ cpu: { product_id: "cpu-1" }, gpu: { name: "RTX 3070", owned: true } });
    const gpu = derivedBuildFromSnapshot(snap, null, "INR").components.find((c) => c.category === "gpu");
    expect(gpu).toMatchObject({ name: "RTX 3070", price: 0, kept: "owned" });
    expect(gpu?.notInCatalog).toBeFalsy();
  });
});

describe("unpurchasableParts", () => {
  const byId = new Map<string, { category: string; in_stock?: boolean }>([
    ["cpu-1", { category: "cpu", in_stock: true }],
    ["ram-old", { category: "ram", in_stock: false }],
    ["case-1", { category: "cooler", in_stock: true }]
  ]);
  const stocked = async (category: string) => category !== "psu";

  it("names placeholders, unknown IDs, out-of-stock and miscategorised parts, but not owned or included ones", async () => {
    const snap: BuildSnapshot = {
      ...snapshotOf({}),
      components: [
        { category: "cpu", product_id: "cpu-1", name: "Ryzen", price: 1, currency: "INR" },
        { category: "motherboard", name: "AM4 Motherboard", price: null, currency: "INR" },
        { category: "storage", product_id: "093b82df0b", name: "093b82df0b", price: null, currency: "INR" },
        { category: "ram", product_id: "ram-old", name: "Old kit", price: 5, currency: "INR" },
        { category: "case", product_id: "case-1", name: "Some cooler", price: 5, currency: "INR" },
        { category: "gpu", name: "RTX 3070", price: 0, currency: "INR", owned: true },
        { category: "cooler", name: "Stock Cooler", price: 0, currency: "INR", included: true },
        // No in-stock PSU in this catalog: a derived requirement is allowed.
        { category: "psu", name: "Any 650 W PSU", price: null, currency: "INR" }
      ]
    };
    expect(await unpurchasableParts(snap, byId, stocked)).toEqual([
      { category: "motherboard", name: "AM4 Motherboard", reason: "not a catalog product" },
      { category: "storage", name: "093b82df0b", reason: "unknown product ID" },
      { category: "ram", name: "Old kit", reason: "out of stock" },
      { category: "case", name: "Some cooler", reason: "listed under another category" }
    ]);
  });
});

describe("in-stock matches for unpurchasable parts", () => {
  it("search by the name, then by its model-number token", () => {
    expect(partMatchTerms("Intel Core i3-10100")).toEqual(["Intel Core i3-10100", "10100"]);
    expect(partMatchTerms("intel-core-i3-10100")).toEqual(["intel-core-i3-10100", "10100"]);
    expect(partMatchTerms("Any case")).toEqual(["Any case"]);
  });

  it("are listed per part and named in the fix-it note", async () => {
    const snap: BuildSnapshot = {
      ...snapshotOf({}),
      components: [{ category: "cpu", product_id: "intel-core-i3-10100", name: "intel-core-i3-10100", price: null, currency: "INR" }]
    };
    const match = { product_id: "ab12cd34ef", name: "Intel Core i3-10100F", price: 6999 };
    const parts = await unpurchasableParts(snap, new Map(), async () => true, async (category, name) => (category === "cpu" && name.includes("10100") ? [match] : []));
    expect(parts).toEqual([{ category: "cpu", name: "intel-core-i3-10100", reason: "unknown product ID", in_stock_matches: [match] }]);
    expect(notPurchasableNote(parts)).toContain('cpu "intel-core-i3-10100" (unknown product ID; in stock: ab12cd34ef Intel Core i3-10100F at 6999)');
  });
});

describe("a build with unpurchasable parts", () => {
  const notPurchasable = [{ category: "motherboard", name: "AM4 Motherboard", reason: "not a catalog product" as const }];
  const entry = {
    ...validation,
    snapshot: { ...snapshotOf({ cpu: { product_id: "cpu-1" } }), components: [{ category: "cpu", product_id: "cpu-1", name: "R5", price: 1, currency: "INR" }, { category: "motherboard", name: "AM4 Motherboard", price: null, currency: "INR" }] },
    not_purchasable: notPurchasable
  };

  it("is refused by present_build with the fix-it note", async () => {
    const store = createTurnValidationStore();
    recordValidation(store, "Within budget", entry as never);
    const tool = createPresentBuildTool(store);
    const out = await (tool.execute as (i: unknown, o: unknown) => Promise<unknown>)({ builds: [{ label: "Within budget" }] }, {});
    expect(out).toEqual({ presented: false, error: notPurchasableNote(notPurchasable) });
  });

  it("doesn't count as validated, so the last step isn't forced to present it", () => {
    const steps = [{ toolCalls: [{ toolCallId: "v", toolName: "validate_build" }], toolResults: [{ toolCallId: "v", toolName: "validate_build", output: { builds: { "Within budget": entry } } }] }];
    expect(hasSuccessfulValidation(steps)).toBe(false);
    const purchasable = { ...entry, not_purchasable: undefined };
    expect(hasSuccessfulValidation([{ ...steps[0], toolResults: [{ ...steps[0].toolResults[0], output: { builds: { "Within budget": purchasable } } }] }])).toBe(true);
  });
});

describe("a validated build missing core parts", () => {
  const present = async (missing: string[]) => {
    const store = createTurnValidationStore();
    recordValidation(store, "Within budget", { ...validation, snapshot: snapshotOf({ cpu: { product_id: "cpu-1" } }), missing_parts: missing } as never);
    return (createPresentBuildTool(store).execute as (i: unknown, o: unknown) => Promise<{ presented: boolean; error?: string }>)({ builds: [{ label: "Within budget" }] }, {});
  };

  it("is refused when it is a whole build (it has a motherboard)", async () => {
    const out = await present(["storage"]);
    expect(out.presented).toBe(false);
    expect(out.error).toContain("missing storage");
    // A board with no CPU is a whole build missing its CPU (r35 4k presented three).
    expect((await present(["cpu"])).error).toContain("missing cpu");
  });

  it("still presents an upgrade pick without a motherboard", async () => {
    expect((await present(["cpu", "motherboard", "ram", "storage", "psu", "case"])).presented).toBe(true);
    expect((await present(["motherboard", "ram", "storage", "psu", "case"])).presented).toBe(true);
  });

  it("doesn't count as validated, so the last step isn't forced to present it", () => {
    const entry = { ...validation, snapshot: snapshotOf({ cpu: { product_id: "cpu-1" } }), missing_parts: ["storage"] };
    const steps = [{ toolCalls: [{ toolCallId: "v", toolName: "validate_build" }], toolResults: [{ toolCallId: "v", toolName: "validate_build", output: { builds: { A: entry } } }] }];
    expect(hasSuccessfulValidation(steps)).toBe(false);
  });
});

describe("a validated build with an owned part the user never named", () => {
  it("doesn't count as validated, so the last step isn't forced to present it", () => {
    const entry = { ...validation, snapshot: snapshotOf({ cpu: { product_id: "cpu-1" }, motherboard: { product_id: "mb-1" } }), unnamed_owned: ['cpu "Intel Core i9-14900K"'] };
    const steps = [{ toolCalls: [{ toolCallId: "v", toolName: "validate_build" }], toolResults: [{ toolCallId: "v", toolName: "validate_build", output: { builds: { A: entry } } }] }];
    expect(hasSuccessfulValidation(steps)).toBe(false);
    const named = { ...entry, unnamed_owned: undefined };
    expect(hasSuccessfulValidation([{ ...steps[0], toolResults: [{ ...steps[0].toolResults[0], output: { builds: { A: named } } }] }])).toBe(true);
  });
});

describe("stock cooler entries", () => {
  it("count as included when the name says stock, included or boxed, unless negated", async () => {
    const { isMarkedIncluded } = await import("../../rules-engine");
    expect(isMarkedIncluded({ name: "Stock cooler (included with Ryzen 5 5600G)" })).toBe(true);
    expect(isMarkedIncluded("included")).toBe(true);
    expect(isMarkedIncluded({ name: "AMD Wraith boxed cooler" })).toBe(true);
    expect(isMarkedIncluded({ name: "No stock cooler" })).toBe(false);
    expect(isMarkedIncluded({ name: "Cooler not included" })).toBe(false);
    expect(isMarkedIncluded({ name: "DeepCool AK400" })).toBe(false);
    expect(isMarkedIncluded({ product_id: "abc12345", name: "Stock cooler" })).toBe(false);
    const snap = snapshotOf({ cpu: { product_id: "cpu-1" }, cooler: { name: "Stock cooler (included with Ryzen 5 5600G)" } });
    expect(snap.components.find((c) => c.category === "cooler")).toMatchObject({ price: 0, included: true });
  });
});
