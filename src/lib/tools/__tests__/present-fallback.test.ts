import { describe, expect, it } from "vitest";
import { deriveBuildsFromToolParts, derivedBuildsFromValidation } from "@/features/chat/build-derive";
import type { ToolPart } from "@/features/chat/tool-chip";

const FULL_CPU = "da6670a41d06377759be1c70e28f32230239c099";
const FULL_BOARD = "b2f9d25f2b06377759be1c70e28f32230239c200";

function validationPart(): ToolPart {
  return {
    type: "tool-validate_build",
    toolCallId: "v1",
    state: "output-available",
    input: { builds: [{ label: "Within budget", parts: {} }] },
    output: {
      builds: {
        "Within budget": {
          valid: true,
          issues: [],
          resolved: {},
          summary: { passed: 1, failed: 0, unverified: 0, text: "ok" },
          snapshot: {
            label: "Within budget",
            components: [
              { category: "cpu", product_id: FULL_CPU, name: "Intel Core i9-14900K", price: 55000, currency: "INR" },
              { category: "motherboard", product_id: FULL_BOARD, name: "ASUS Board", price: 45000, currency: "INR" }
            ],
            total: 100000,
            subtotal: 100000,
            currency: "INR",
            is_complete: true,
            component_count: 2,
            unpriced_count: 0,
            missing_prices: [],
            currencies: ["INR"],
            parts: {},
            valid: true,
            created_at: new Date().toISOString()
          }
        }
      }
    }
  } as unknown as ToolPart;
}

describe("present fallback and prefix matching", () => {
  it("derives build from presentable validation when present_build is missing", () => {
    const builds = deriveBuildsFromToolParts([validationPart()], "INR");
    expect(builds).toHaveLength(1);
    expect(builds[0].components.map((c) => c.productId)).toContain(FULL_CPU);
  });

  it("does not fall back for invalid or spot-check validations", () => {
    const invalid = validationPart();
    (invalid.output as { builds: Record<string, { valid: boolean }> }).builds["Within budget"].valid = false;
    expect(deriveBuildsFromToolParts([invalid], "INR")).toHaveLength(0);

    const spot = validationPart();
    (spot.output as never as { builds: Record<string, { snapshot: { components: unknown[] } }> }).builds["Within budget"].snapshot.components = [
      { category: "gpu", product_id: FULL_CPU, name: "GPU", price: 1, currency: "INR" }
    ];
    expect(deriveBuildsFromToolParts([spot], "INR")).toHaveLength(0);
  });

  it("matches presented prefixes to snapshot full IDs", () => {
    const present = {
      type: "tool-present_build",
      toolCallId: "p1",
      state: "output-available",
      input: { builds: [{ label: "Within budget", product_ids: [FULL_CPU.slice(0, 10), FULL_BOARD.slice(0, 8)] }] },
      output: { presented: true }
    } as unknown as ToolPart;
    const builds = deriveBuildsFromToolParts([validationPart(), present], "INR");
    expect(builds).toHaveLength(1);
    expect(builds[0].detailsUnavailable).not.toBe(true);
    expect(builds[0].components).toHaveLength(2);
  });

  it("derivedBuildsFromValidation keeps full IDs for UI", () => {
    const [build] = derivedBuildsFromValidation(validationPart(), "INR");
    expect(build.components[0].productId).toBe(FULL_CPU);
  });
});
