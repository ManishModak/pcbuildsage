import { describe, expect, it } from "vitest";
import { GET as getMarkets } from "../route";
import type { MarketMetadata } from "@/lib/config/deployment";

describe("GET /api/markets", () => {
  it("returns HTTP 200 with list of markets", async () => {
    const response = await getMarkets();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { markets: MarketMetadata[] };
    expect(Array.isArray(body.markets)).toBe(true);
    expect(body.markets.length).toBeGreaterThanOrEqual(5);

    for (const market of body.markets) {
      expect(market.code).toMatch(/^[A-Z]{2}$/);
      expect(market.name).toBeDefined();
      expect(market.defaultCurrency).toMatch(/^[A-Z]{3}$/);
      expect(market.supportedCurrencies).toContain(market.defaultCurrency);
      expect(market.locale).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
    }
  });

  it("does not expose scraper internals or filesystem paths", async () => {
    const response = await getMarkets();
    const text = await response.text();
    expect(text).not.toContain("selectors");
    expect(text).not.toContain("sites");
    expect(text).not.toContain("browser_config");
    expect(text).not.toContain("pagination");
    expect(text).not.toContain(".db");
  });
});
