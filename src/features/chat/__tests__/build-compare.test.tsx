import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BuildCard } from "../build-card";
import { BuildCompare, compareBuilds } from "../build-compare";
import type { BuildComponent, DerivedBuild } from "../build-derive";

function part(category: string, name: string, price: number | null): BuildComponent {
  return {
    category,
    categoryLabel: category.toUpperCase(),
    name,
    productId: `id-${name}`,
    price,
    currency: "INR",
    retailer: "mdcomputers",
    unverified: false
  };
}

function build(label: string, components: BuildComponent[], total?: number | null): DerivedBuild {
  return { label, components, currency: "INR", validation: null, ...(total !== undefined ? { total } : {}) };
}

const value = build("Value", [part("cpu", "Ryzen 5 7600", 18000), part("gpu", "RTX 5060", 30000)]);
const fast = build("Faster", [part("cpu", "Ryzen 5 7600", 18000), part("gpu", "RX 9070", 55000), part("ssd", "2TB SSD", 9000)]);

describe("compareBuilds", () => {
  it("lines up categories, marks shared parts, and prices each build against the cheapest", () => {
    const { rows, totals, deltas } = compareBuilds([value, fast]);
    expect(rows.map((r) => [r.category, r.same])).toEqual([
      ["cpu", true],
      ["gpu", false],
      ["ssd", false]
    ]);
    expect(rows[2].parts[0]).toEqual([]);
    expect(totals).toEqual([48000, 82000]);
    expect(deltas).toEqual([0, 34000]);
  });

  it("treats the same parts in a different order as the same", () => {
    const a = build("A", [part("ssd", "1TB", 5000), part("ssd", "2TB", 9000)]);
    const b = build("B", [part("ssd", "2TB", 9000), part("ssd", "1TB", 5000)]);
    expect(compareBuilds([a, b]).rows[0].same).toBe(true);
  });

  it("gives no difference when a total is unknown", () => {
    const unpriced = build("Unpriced", [part("cpu", "Ryzen 5 7600", 18000)], null);
    expect(compareBuilds([value, unpriced]).deltas).toEqual([null, null]);
  });
});

describe("build card Compare tab", () => {
  it("is offered for two or more builds with parts", () => {
    expect(renderToStaticMarkup(<BuildCard builds={[value, fast]} />)).toContain(">Compare<");
    expect(renderToStaticMarkup(<BuildCard builds={[value]} />)).not.toContain(">Compare<");
    const missing = build("Missing", [], undefined);
    expect(renderToStaticMarkup(<BuildCard builds={[value, { ...missing, detailsUnavailable: true }]} />)).not.toContain(
      ">Compare<"
    );
  });

  it("shows shared parts once and each build's own parts in its column", () => {
    const html = renderToStaticMarkup(<BuildCompare builds={[value, fast]} onPick={() => {}} />);
    expect(html.match(/Ryzen 5 7600/g)).toHaveLength(1);
    expect(html).toContain("CPU · same in every build");
    expect(html).toContain("RTX 5060");
    expect(html).toContain("RX 9070");
    expect(html).toContain("Lowest total");
    expect(html).toMatch(/34,000(\.00)? more/);
  });
});
