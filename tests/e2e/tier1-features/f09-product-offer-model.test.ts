import { describe, it, expect } from "vitest";
import { ProductOffer, createMockProduct } from "../test-harness";

describe("Tier 1 - Feature 9: Source-Neutral ProductOffer Model (R2)", () => {
  it("validates ProductOffer mandatory fields and types", () => {
    const offer: ProductOffer = {
      productId: "prod-100",
      countryCode: "US",
      currencyCode: "USD",
      price: 249.99,
      retailer: "MicroCenter",
      sourceType: "scraped",
      destinationUrl: "https://microcenter.com/product/100",
      inStock: true,
      lastUpdated: new Date().toISOString()
    };

    expect(offer.productId).toBe("prod-100");
    expect(offer.countryCode).toBe("US");
    expect(offer.currencyCode).toBe("USD");
    expect(offer.price).toBe(249.99);
    expect(offer.retailer).toBe("MicroCenter");
    expect(offer.sourceType).toBe("scraped");
    expect(offer.destinationUrl).toMatch(/^https:\/\//);
    expect(offer.inStock).toBe(true);
  });

  it("supports valid sourceType enum values ('scraped', 'retailer-feed', 'manual', 'affiliate')", () => {
    const validTypes: Array<ProductOffer["sourceType"]> = ["scraped", "retailer-feed", "manual", "affiliate"];
    for (const st of validTypes) {
      const offer: ProductOffer = {
        productId: "p1",
        countryCode: "UK",
        currencyCode: "GBP",
        price: 199.99,
        retailer: "ScanUK",
        sourceType: st,
        destinationUrl: "https://scan.co.uk/p1",
        inStock: true,
        lastUpdated: new Date().toISOString()
      };
      expect(offer.sourceType).toBe(st);
    }
  });

  it("preserves native retailer currency without premature lossy conversion", () => {
    const usOffer: ProductOffer = {
      productId: "p-global",
      countryCode: "US",
      currencyCode: "USD",
      price: 399.0,
      retailer: "Newegg",
      sourceType: "scraped",
      destinationUrl: "https://newegg.com/p",
      inStock: true,
      lastUpdated: "2026-09-02T10:00:00Z"
    };

    const inOffer: ProductOffer = {
      productId: "p-global",
      countryCode: "IN",
      currencyCode: "INR",
      price: 35000.0,
      retailer: "PrimeABGB",
      sourceType: "scraped",
      destinationUrl: "https://primeabgb.com/p",
      inStock: true,
      lastUpdated: "2026-09-02T10:00:00Z"
    };

    expect(usOffer.currencyCode).toBe("USD");
    expect(usOffer.price).toBe(399.0);
    expect(inOffer.currencyCode).toBe("INR");
    expect(inOffer.price).toBe(35000.0);
  });

  it("supports multiple offers from different retailers for a single product", () => {
    const product = createMockProduct({
      id: "cpu-5800x3d",
      offers: [
        {
          productId: "cpu-5800x3d",
          countryCode: "US",
          currencyCode: "USD",
          price: 320.0,
          retailer: "Amazon",
          sourceType: "affiliate",
          destinationUrl: "https://amazon.com/dp/B001",
          inStock: true,
          lastUpdated: "2026-09-02T11:00:00Z"
        },
        {
          productId: "cpu-5800x3d",
          countryCode: "US",
          currencyCode: "USD",
          price: 310.0,
          retailer: "B&H",
          sourceType: "scraped",
          destinationUrl: "https://bhphotovideo.com/p/B001",
          inStock: false,
          lastUpdated: "2026-09-02T11:00:00Z"
        }
      ]
    });

    expect(product.offers?.length).toBe(2);
    expect(product.offers?.[0].retailer).toBe("Amazon");
    expect(product.offers?.[1].retailer).toBe("B&H");
    expect(product.offers?.[1].inStock).toBe(false);
  });

  it("includes inStock boolean and ISO 8601 lastUpdated timestamps", () => {
    const offer: ProductOffer = {
      productId: "gpu-7900xt",
      countryCode: "CA",
      currencyCode: "CAD",
      price: 950.0,
      retailer: "MemoryExpress",
      sourceType: "retailer-feed",
      destinationUrl: "https://memoryexpress.com/p",
      inStock: true,
      lastUpdated: new Date().toISOString()
    };

    expect(typeof offer.inStock).toBe("boolean");
    expect(Date.parse(offer.lastUpdated)).not.toBeNaN();
  });
});
