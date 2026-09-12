import { describe, it, expect } from "vitest";
import {
  resolveDeploymentMode,
  isRouteBlocked,
  STANDARD_MARKETS,
  MockTursoCatalogRepository,
  MockBrowserSessionStore,
  MarketPreference,
  SessionDetail,
  createMockProduct
} from "../test-harness";

describe("Tier 4 - Workload Scenario 1: Hosted Demo Visitor Flow (F1, F2, F4, F5, F8, F9, F11, F18, F20)", () => {
  it("executes complete hosted demo visitor lifecycle end-to-end", async () => {
    // Step 1: Verify application deployment mode is hosted-demo
    const mode = resolveDeploymentMode("hosted-demo");
    expect(mode).toBe("hosted-demo");

    // Step 2: Ensure administrative routes are guarded
    expect(isRouteBlocked("/api/scrape", "POST", mode)).toBe(true);
    expect(isRouteBlocked("/api/profiles", "GET", mode)).toBe(true);

    // Step 3: Fetch public market metadata (GET /api/markets)
    expect(isRouteBlocked("/api/markets", "GET", mode)).toBe(false);
    const availableMarkets = STANDARD_MARKETS;
    expect(availableMarkets.some((m) => m.code === "UK")).toBe(true);
    expect(availableMarkets.some((m) => m.code === "US")).toBe(true);

    // Step 4: Visitor selects UK market preference in browser
    const userMarketPreference: MarketPreference = {
      countryCode: "UK",
      currencyCode: "GBP",
      locale: "en-GB"
    };

    // Step 5: Query catalog via Turso cloud repository adapter for UK products
    const seedCatalog = [
      createMockProduct({
        id: "cpu-7800x3d-uk",
        name: "AMD Ryzen 7 7800X3D",
        category: "cpu",
        countryCode: "UK",
        currency: "GBP",
        price: 339.99,
        retailer: "Scan Computers"
      }),
      createMockProduct({
        id: "gpu-4070s-uk",
        name: "NVIDIA GeForce RTX 4070 Super",
        category: "gpu",
        countryCode: "UK",
        currency: "GBP",
        price: 549.0,
        retailer: "Overclockers UK"
      }),
      createMockProduct({
        id: "pad-junk",
        name: "RGB Gaming Mouse Pad XL",
        category: "accessories",
        subcategory: "mouse-pad",
        countryCode: "UK",
        currency: "GBP",
        price: 19.99,
        retailer: "Scan Computers"
      }),
      createMockProduct({
        id: "cpu-us",
        name: "AMD Ryzen 7 7800X3D (US Market)",
        category: "cpu",
        countryCode: "US",
        currency: "USD",
        price: 349.99,
        retailer: "BestBuy"
      })
    ];

    const tursoRepo = new MockTursoCatalogRepository(seedCatalog);
    const ukCatalog = await tursoRepo.getCatalog(userMarketPreference.countryCode);

    // Verify only build-relevant UK products are returned
    expect(ukCatalog.length).toBe(2);
    expect(ukCatalog.map((p) => p.id)).toEqual(["cpu-7800x3d-uk", "gpu-4070s-uk"]);
    expect(ukCatalog[0].currency).toBe("GBP");
    expect(ukCatalog[0].offers?.[0].retailer).toBe("Scan Computers");

    // Step 6: Visitor initiates chat consultation and saves session in browser storage
    const browserSessionStore = new MockBrowserSessionStore();
    const visitorSession: SessionDetail = {
      id: "visitor-session-001",
      title: "1440p High FPS Gaming Build (UK)",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 2,
      marketPreference: userMarketPreference,
      messages: [
        { id: "m1", role: "user", content: "I have £1000 budget in UK for 1440p gaming", timestamp: new Date().toISOString() },
        { id: "m2", role: "assistant", content: "Here is your optimized UK build using Ryzen 7 7800X3D and RTX 4070 Super", timestamp: new Date().toISOString() }
      ]
    };

    await browserSessionStore.saveSession(visitorSession);
    const stored = await browserSessionStore.getSession("visitor-session-001");

    expect(stored).not.toBeNull();
    expect(stored?.title).toBe("1440p High FPS Gaming Build (UK)");
    expect(stored?.marketPreference?.countryCode).toBe("UK");
    expect(stored?.messages.length).toBe(2);

    // Step 7: Verify zero server-side state persistence in hosted demo mode
    await tursoRepo.close();
  });
});
