import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BuildCard } from "../build-card";
import type { DerivedBuild, BuildComponent } from "../build-derive";
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

  it("links catalog parts with the disclosure, but not derived requirements", () => {
    const html = renderToStaticMarkup(
      <BuildCard
        builds={[
          build([
            part({}),
            part({ category: "psu", categoryLabel: "PSU", name: "Any 650 W PSU", retailer: undefined, url: undefined, price: null })
          ])
        ]}
      />
    );
    expect(html.match(/Check on Amazon/g)).toHaveLength(1);
    expect(html).toContain('rel="sponsored noopener noreferrer"');
    expect(html).toContain(AMAZON_DISCLOSURE);
  });

  it("shows no Amazon link or disclosure outside India", () => {
    const html = renderToStaticMarkup(<BuildCard builds={[build([part({ currency: "USD" })], "USD")]} />);
    expect(html).not.toContain("Check on Amazon");
    expect(html).not.toContain(AMAZON_DISCLOSURE);
  });
});
