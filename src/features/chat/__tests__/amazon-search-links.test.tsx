import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BuildCard } from "../build-card";
import { derivedBuildFromSnapshot, type DerivedBuild, type BuildComponent } from "../build-derive";
import type { BuildSnapshot } from "@/lib/catalog/build-snapshot";
import { AMAZON_DISCLOSURE, amazonSearchUrl } from "@/lib/amazon-search";

function part(overrides: Partial<BuildComponent>): BuildComponent {
  return {
    category: "gpu",
    categoryLabel: "GPU",
    name: "ASUS Dual RTX 5060 8GB",
    price: 30000,
    currency: "INR",
    retailer: "MDComputers",
    url: "https://mdcomputers.in/product/asus-dual-rtx-5060",
    unverified: false,
    ...overrides
  };
}

function build(components: BuildComponent[], currency = "INR"): DerivedBuild {
  return { components, currency, validation: null };
}

describe("Amazon search links", () => {
  it("builds a tagged amazon.in search for Indian prices only", () => {
    const url = new URL(amazonSearchUrl("  ASUS  Dual RTX 5060 8GB ", "INR")!);
    expect(url.origin + url.pathname).toBe("https://www.amazon.in/s");
    expect(url.searchParams.get("k")).toBe("ASUS Dual RTX 5060 8GB");
    expect(url.searchParams.get("tag")).toBe("pcbuildsage-21");
    expect(amazonSearchUrl("ASUS Dual RTX 5060 8GB", "USD")).toBeNull();
    expect(amazonSearchUrl("   ", "INR")).toBeNull();
  });

  it("links store listings with the disclosure, but not unpriced requirements", () => {
    const snapshot = {
      currency: "INR",
      total: null,
      components: [
        { category: "gpu", name: "ASUS Dual RTX 5060 8GB", price: 30000, currency: "INR", retailer: "MDComputers" },
        { category: "psu", name: "Any 650 W PSU", price: null, currency: "INR" }
      ]
    } as BuildSnapshot;
    const html = renderToStaticMarkup(<BuildCard builds={[derivedBuildFromSnapshot(snapshot, null)]} />);
    expect(html.match(/Check on Amazon \(paid link\)/g)).toHaveLength(1);
    expect(html).toContain('rel="sponsored noopener"');
    expect(html).toContain(AMAZON_DISCLOSURE);
  });

  it("shows no Amazon link or disclosure outside India", () => {
    const html = renderToStaticMarkup(<BuildCard builds={[build([part({ currency: "USD" })], "USD")]} />);
    expect(html).not.toContain("Check on Amazon");
    expect(html).not.toContain(AMAZON_DISCLOSURE);
  });
});
