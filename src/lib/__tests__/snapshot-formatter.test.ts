import { describe, expect, it } from "vitest";
import type { BuildSnapshot } from "../catalog/build-snapshot";
import {
  formatSingleSnapshot,
  formatSnapshotsForContext,
  formatSnapshotForContext
} from "../llm/snapshot-formatter";

describe("snapshot-formatter", () => {
  const makeSnapshot = (label: string, gpuName: string, price: number): BuildSnapshot => ({
    label,
    components: [
      {
        category: "gpu",
        product_id: `id-${label.toLowerCase().replace(/\s+/g, "-")}`,
        name: gpuName,
        price,
        currency: "USD",
        retailer: "BestBuy",
        included: false
      }
    ],
    total: price,
    subtotal: price,
    currency: "USD",
    is_complete: true,
    component_count: 1,
    unpriced_count: 0,
    missing_prices: [],
    currencies: ["USD"],
    parts: { gpu: { product_id: "test" } },
    valid: true,
    validation_summary: {
      passed: 6,
      failed: 0,
      unverified: 0,
      skipped: 0,
      issues: []
    },
    created_at: "2026-09-14T00:00:00Z"
  });

  it("formats a single snapshot with components and totals", () => {
    const snap = makeSnapshot("Budget Tier", "NVIDIA RTX 4060", 299.99);
    const result = formatSingleSnapshot(snap);

    expect(result).toContain("Current Build Snapshot (Code-Calculated, Authoritative):");
    expect(result).toContain("Label: Budget Tier");
    expect(result).toContain("Compatibility: PASSED (6 check(s) verified)");
    expect(result).toContain("Total: USD 299.99");
    expect(result).toContain("- GPU: NVIDIA RTX 4060 [ID: id-budget-tier] — USD 299.99 (Retailer: BestBuy)");
  });

  it("formats multiple snapshots separated by dividers", () => {
    const snap1 = makeSnapshot("Tier 1", "RTX 4060", 300);
    const snap2 = makeSnapshot("Tier 2", "RTX 4070", 600);
    const result = formatSnapshotsForContext([snap1, snap2]);

    expect(result).toContain("Label: Tier 1");
    expect(result).toContain("Total: USD 300");
    expect(result).toContain("---");
    expect(result).toContain("Label: Tier 2");
    expect(result).toContain("Total: USD 600");
  });

  it("handles empty snapshots array gracefully in formatSnapshotsForContext", () => {
    expect(formatSnapshotsForContext([])).toBe("");
  });

  it("formatSnapshotForContext supports both single snapshot and array of snapshots", () => {
    const snap1 = makeSnapshot("Single", "RTX 4060", 300);
    const snap2 = makeSnapshot("Second", "RTX 4070", 600);

    const singleResult = formatSnapshotForContext(snap1);
    expect(singleResult).toContain("Label: Single");
    expect(singleResult).not.toContain("---");

    const arrayResult = formatSnapshotForContext([snap1, snap2]);
    expect(arrayResult).toContain("Label: Single");
    expect(arrayResult).toContain("---");
    expect(arrayResult).toContain("Label: Second");
  });
});
