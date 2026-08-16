import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BuildCard } from "../build-card";
import { deriveBuilds, type DerivedBuild } from "../build-derive";
import type { ToolPart } from "../tool-chip";

describe("side panel build presentation", () => {
  it("renders BuildCard cleanly in side panel mode with component rows and totals", () => {
    const builds: DerivedBuild[] = [
      {
        label: "RTX 5060 Workstation",
        currency: "INR",
        validation: null,
        components: [
          {
            category: "gpu",
            categoryLabel: "GPU",
            name: "Nvidia RTX 5060 8GB",
            price: 35900,
            currency: "INR",
            retailer: "Kryptronix",
            url: "https://kryptronix.in/rtx5060",
            unverified: false
          },
          {
            category: "cpu",
            categoryLabel: "CPU",
            name: "AMD Ryzen 5 7600",
            price: 18500,
            currency: "INR",
            unverified: false
          }
        ]
      }
    ];

    const markup = renderToStaticMarkup(<BuildCard builds={builds} inSidePanel />);

    expect(markup).toContain("RTX 5060 Workstation");
    expect(markup).toContain("GPU");
    expect(markup).toContain("Nvidia RTX 5060 8GB");
    expect(markup).toContain("Kryptronix");
    expect(markup).toContain("https://kryptronix.in/rtx5060");
    expect(markup).toContain("₹35,900");
    expect(markup).toContain("CPU");
    expect(markup).toContain("AMD Ryzen 5 7600");
    expect(markup).toContain("₹18,500");
    expect(markup).toContain("Total");
    expect(markup).toContain("₹54,400");
  });

  it("renders pill tabs when multiple build options are presented in BuildCard", () => {
    const builds: DerivedBuild[] = [
      {
        label: "Option A: 1440p High FPS",
        currency: "INR",
        validation: null,
        components: [
          {
            category: "gpu",
            categoryLabel: "GPU",
            name: "RTX 4070 Super",
            price: 59000,
            currency: "INR",
            unverified: false
          }
        ]
      },
      {
        label: "Option B: Budget 1080p",
        currency: "INR",
        validation: null,
        components: [
          {
            category: "gpu",
            categoryLabel: "GPU",
            name: "RTX 4060",
            price: 28500,
            currency: "INR",
            unverified: false
          }
        ]
      }
    ];

    const markup = renderToStaticMarkup(<BuildCard builds={builds} inSidePanel />);

    expect(markup).toContain("Option A: 1440p High FPS");
    expect(markup).toContain("Option B: Budget 1080p");
    expect(markup).toContain('role="tablist"');
  });

  it("derives multiple builds correctly from present_build tool parts", () => {
    const parts: ToolPart[] = [
      {
        type: "tool-present_build",
        toolCallId: "call-10",
        state: "output-available",
        input: {
          builds: [
            {
              label: "Creator Pro",
              parts: [
                { category: "cpu", name: "Ryzen 9 7900X", price: 38000, currency: "INR" },
                { category: "gpu", name: "RTX 4080 Super", price: 98000, currency: "INR" }
              ]
            }
          ]
        },
        output: { presented: true, buildCount: 1 }
      }
    ];

    const derived = deriveBuilds(parts, "INR");
    expect(derived).toHaveLength(1);
    expect(derived[0].label).toBe("Creator Pro");
    expect(derived[0].components).toHaveLength(2);
    // GPUs sorted before CPUs by CATEGORY_ORDER
    expect(derived[0].components[0].category).toBe("gpu");
    expect(derived[0].components[1].category).toBe("cpu");
  });
});
