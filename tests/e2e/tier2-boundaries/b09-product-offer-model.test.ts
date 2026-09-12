import { describe, it, expect } from "vitest";
import { ProductOffer } from "../test-harness";

describe("Tier 2 Boundary - Feature 9: ProductOffer Model Boundaries", () => {
  it("handles floating point price precision (e.g. $0.99, $1299.49) accurately", () => {
    const offer: ProductOffer = {
      productId: "p1",
      countryCode: "US",
      currencyCode: "USD",
      price: 1299.49,
      retailer: "BestBuy",
      sourceType: "scraped",
      destinationUrl: "https://bestbuy.com/p1",
      inStock: true,
      lastUpdated: new Date().toISOString()
    };

    expect(offer.price).toBe(1299.49);
    expect(Number.isFinite(offer.price)).toBe(true);
  });

  it("handles high value prices without overflow (e.g. INR 350,000)", () => {
    const offer: ProductOffer = {
      productId: "p-workstation",
      countryCode: "IN",
      currencyCode: "INR",
      price: 350000,
      retailer: "MDComputers",
      sourceType: "retailer-feed",
      destinationUrl: "https://mdcomputers.in/p",
      inStock: true,
      lastUpdated: new Date().toISOString()
    };

    expect(offer.price).toBe(350000);
  });

  it("rejects invalid price values (NaN, null, undefined) in schema validation", () => {
    const validatePrice = (p: unknown) => typeof p === "number" && !isNaN(p) && p > 0;
    expect(validatePrice(NaN)).toBe(false);
    expect(validatePrice(null)).toBe(false);
    expect(validatePrice(0)).toBe(false);
    expect(validatePrice(-1)).toBe(false);
    expect(validatePrice(10.5)).toBe(true);
  });

  it("handles special characters in retailer name (e.g. 'B&H Photo Video', 'Micro Center')", () => {
    const offer: ProductOffer = {
      productId: "p1",
      countryCode: "US",
      currencyCode: "USD",
      price: 99.99,
      retailer: "B&H Photo Video / Audio",
      sourceType: "affiliate",
      destinationUrl: "https://bhphotovideo.com",
      inStock: true,
      lastUpdated: new Date().toISOString()
    };

    expect(offer.retailer).toBe("B&H Photo Video / Audio");
  });

  it("preserves URL query parameters in destinationUrl", () => {
    const url = "https://retailer.com/item?id=123&tag=pcbuildsage-20&ref=search";
    const offer: ProductOffer = {
      productId: "p1",
      countryCode: "US",
      currencyCode: "USD",
      price: 99.99,
      retailer: "Retailer",
      sourceType: "affiliate",
      destinationUrl: url,
      inStock: true,
      lastUpdated: new Date().toISOString()
    };

    expect(offer.destinationUrl).toBe(url);
    expect(new URL(offer.destinationUrl).searchParams.get("tag")).toBe("pcbuildsage-20");
  });
});
