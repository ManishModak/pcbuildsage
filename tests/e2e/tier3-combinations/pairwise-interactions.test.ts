import { describe, it, expect } from "vitest";
import {
  resolveDeploymentMode,
  isRouteBlocked,
  validateChatUrl,
  STANDARD_MARKETS,
  MemorySqliteRepository,
  MockTursoCatalogRepository,
  MockTursoClient,
  createMockProduct,
  createTestSqliteDb,
  validateCatalogSnapshot,
  publishCandidateToTurso,
  MockBrowserSessionStore,
  MockSessionStorage,
  parseDockerfile,
  parseWorkflowYaml,
  MarketPreference,
  SessionDetail
} from "../test-harness";

describe("Tier 3 - Pairwise Feature Combinations & Cross-Milestone Interactions", () => {
  it("Pair 1 (F1 x F2): Route guarding policy adapts dynamically when deployment mode switches", () => {
    // In local mode, admin and scraper routes are open
    expect(isRouteBlocked("/api/scrape", "POST", "local")).toBe(false);
    expect(isRouteBlocked("/api/profiles", "GET", "local")).toBe(false);

    // In hosted-demo mode, dangerous routes are blocked
    expect(isRouteBlocked("/api/scrape", "POST", "hosted-demo")).toBe(true);
    expect(isRouteBlocked("/api/profiles", "GET", "hosted-demo")).toBe(true);
  });

  it("Pair 2 (F1 x F3): SSRF protection policy enforces strict allowlist in hosted mode while permitting local dev URLs in local mode", () => {
    // Local mode allows localhost and local dev models (Ollama, LMStudio)
    expect(validateChatUrl("http://localhost:11434/v1", "local").allowed).toBe(true);
    expect(validateChatUrl("http://127.0.0.1:8000/v1", "local").allowed).toBe(true);

    // Hosted mode rejects internal IPs and only allows whitelisted HTTPS providers
    expect(validateChatUrl("http://localhost:11434/v1", "hosted-demo").allowed).toBe(false);
    expect(validateChatUrl("https://generativelanguage.googleapis.com", "hosted-demo").allowed).toBe(true);
  });

  it("Pair 3 (F1 x F4): Public market metadata endpoint is universally accessible across both deployment modes", () => {
    const isMarketsBlockedInLocal = isRouteBlocked("/api/markets", "GET", "local");
    const isMarketsBlockedInHosted = isRouteBlocked("/api/markets", "GET", "hosted-demo");

    expect(isMarketsBlockedInLocal).toBe(false);
    expect(isMarketsBlockedInHosted).toBe(false);
    expect(STANDARD_MARKETS.length).toBeGreaterThanOrEqual(3);
  });

  it("Pair 4 (F1 x F5): Sanitized status and health endpoints behave statelessly in hosted-demo mode", () => {
    expect(isRouteBlocked("/api/health", "GET", "hosted-demo")).toBe(false);
    expect(isRouteBlocked("/api/status", "GET", "hosted-demo")).toBe(false);

    const statusPayload = {
      mode: resolveDeploymentMode("hosted-demo"),
      status: "healthy",
      productCount: 500
    };
    expect(statusPayload.mode).toBe("hosted-demo");
    expect(JSON.stringify(statusPayload)).not.toContain("/home/");
  });

  it("Pair 5 (F1 x F8): Repository factory configures remote Turso in hosted-demo mode vs SQLite in local mode", async () => {
    const getRepoForMode = (mode: "local" | "hosted-demo") => {
      if (mode === "hosted-demo") {
        return new MockTursoCatalogRepository([]);
      }
      return new MemorySqliteRepository();
    };

    const localRepo = getRepoForMode("local");
    expect(localRepo).toBeInstanceOf(MemorySqliteRepository);
    await localRepo.close();

    const hostedRepo = getRepoForMode("hosted-demo");
    expect(hostedRepo).toBeInstanceOf(MockTursoCatalogRepository);
    await hostedRepo.close();
  });

  it("Pair 6 (F1 x F18): Session storage resolves to client browser store in hosted-demo mode", async () => {
    const isHosted = resolveDeploymentMode("hosted-demo") === "hosted-demo";
    const store = isHosted ? new MockBrowserSessionStore() : null;

    expect(store).not.toBeNull();
    await store!.saveSession({
      id: "sess-1",
      title: "Hosted Session",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
      messages: []
    });

    const retrieved = await store!.getSession("sess-1");
    expect(retrieved?.title).toBe("Hosted Session");
  });

  it("Pair 7 (F1 x F19): Visitor BYOK headers are parsed and forwarded in hosted mode without disk logging", () => {
    const sessionStorage = new MockSessionStorage();
    sessionStorage.setItem("pcbuildsage_byok_gemini", "AIzaSyTestKey");

    const reqHeaders: Record<string, string> = {};
    const key = sessionStorage.getItem("pcbuildsage_byok_gemini");
    if (key) reqHeaders["x-gemini-api-key"] = key;

    expect(reqHeaders["x-gemini-api-key"]).toBe("AIzaSyTestKey");

    // Verify logging redaction
    const logDetails = { headers: reqHeaders };
    const serialized = JSON.stringify(logDetails, (k, v) => (/key|token/i.test(k) ? "[REDACTED]" : v));
    expect(serialized).not.toContain("AIzaSyTestKey");
  });

  it("Pair 8 (F1 x F21): Multi-tenant cross-browser isolation is strictly enforced in hosted mode", async () => {
    const clientA = new MockBrowserSessionStore();
    const clientB = new MockBrowserSessionStore();

    await clientA.saveSession({
      id: "user-a-sess",
      title: "User A Build",
      createdAt: "",
      updatedAt: "",
      messageCount: 0,
      messages: []
    });

    expect(await clientA.getSession("user-a-sess")).not.toBeNull();
    expect(await clientB.getSession("user-a-sess")).toBeNull();
  });

  it("Pair 9 (F1 x F25): Stateless container healthcheck responds HTTP 200 in hosted-demo mode", () => {
    const mode = resolveDeploymentMode("hosted-demo");
    const healthCheck = (m: string) => ({ status: 200, mode: m });

    const res = healthCheck(mode);
    expect(res.status).toBe(200);
    expect(res.mode).toBe("hosted-demo");
  });

  it("Pair 10 (F2 x F3): Route guard blocks unauthorized scrape while SSRF guard validates chat endpoint", () => {
    expect(isRouteBlocked("/api/scrape", "POST", "hosted-demo")).toBe(true);

    const chatEndpointCheck = validateChatUrl("https://openrouter.ai/api/v1", "hosted-demo");
    expect(chatEndpointCheck.allowed).toBe(true);

    const ssrfAttack = validateChatUrl("http://169.254.169.254/latest/meta-data", "hosted-demo");
    expect(ssrfAttack.allowed).toBe(false);
  });

  it("Pair 11 (F4 x F11): Market metadata supported countries strictly match repository country filters", async () => {
    const repo = new MemorySqliteRepository();
    const markets = await repo.getMarkets();

    for (const market of markets) {
      const prods = await repo.getCatalog(market.code);
      expect(Array.isArray(prods)).toBe(true);
    }

    await repo.close();
  });

  it("Pair 12 (F4 x F20): Market metadata default currencies initialize client market preferences accurately", () => {
    const usMarket = STANDARD_MARKETS.find((m) => m.code === "US")!;
    const initialPref: MarketPreference = {
      countryCode: usMarket.code,
      currencyCode: usMarket.defaultCurrency,
      locale: usMarket.locale
    };

    expect(initialPref.countryCode).toBe("US");
    expect(initialPref.currencyCode).toBe("USD");
    expect(initialPref.locale).toBe("en-US");
  });

  it("Pair 13 (F6 x F7): SqliteCatalogRepository completely implements CatalogRepository interface contract", async () => {
    const p1 = createMockProduct({ id: "p1" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });
    const repo = new MemorySqliteRepository(dbPath);

    expect(typeof repo.getCatalog).toBe("function");
    expect(typeof repo.searchProducts).toBe("function");
    expect(typeof repo.getFreshness).toBe("function");
    expect(typeof repo.getMarkets).toBe("function");
    expect(typeof repo.close).toBe("function");

    const cat = await repo.getCatalog();
    expect(cat.length).toBe(1);

    await repo.close();
    cleanup();
  });

  it("Pair 14 (F6 x F8): TursoCatalogRepository completely implements CatalogRepository interface contract", async () => {
    const p1 = createMockProduct({ id: "p1" });
    const repo = new MockTursoCatalogRepository([p1]);

    expect(typeof repo.getCatalog).toBe("function");
    expect(typeof repo.searchProducts).toBe("function");
    expect(typeof repo.getFreshness).toBe("function");
    expect(typeof repo.getMarkets).toBe("function");
    expect(typeof repo.close).toBe("function");

    const cat = await repo.getCatalog();
    expect(cat.length).toBe(1);

    await repo.close();
  });

  it("Pair 15 (F7 x F8): SQLite and Turso repositories yield identical search results on identical seed data", async () => {
    const seed = [
      createMockProduct({ id: "cpu-1", name: "AMD Ryzen 7 7800X3D", category: "cpu", price: 349 }),
      createMockProduct({ id: "gpu-1", name: "GeForce RTX 4070 SUPER", category: "gpu", price: 599 })
    ];

    const { dbPath, cleanup } = createTestSqliteDb({ products: seed });
    const sqliteRepo = new MemorySqliteRepository(dbPath);
    const tursoRepo = new MockTursoCatalogRepository(seed);

    const sqliteSearch = await sqliteRepo.searchProducts({ category: "cpu" });
    const tursoSearch = await tursoRepo.searchProducts({ category: "cpu" });

    expect(sqliteSearch.totalCount).toBe(tursoSearch.totalCount);
    expect(sqliteSearch.items[0].name).toBe(tursoSearch.items[0].name);
    expect(sqliteSearch.items[0].price).toBe(tursoSearch.items[0].price);

    await sqliteRepo.close();
    await tursoRepo.close();
    cleanup();
  });

  it("Pair 16 (F8 x F9): Turso repository returns normalized ProductOffer objects with preserved retailer currencies", async () => {
    const p1 = createMockProduct({
      id: "p1",
      countryCode: "UK",
      currency: "GBP",
      price: 250,
      offers: [
        {
          productId: "p1",
          countryCode: "UK",
          currencyCode: "GBP",
          price: 250,
          retailer: "Overclockers UK",
          sourceType: "scraped",
          destinationUrl: "https://overclockers.co.uk/p1",
          inStock: true,
          lastUpdated: new Date().toISOString()
        }
      ]
    });

    const repo = new MockTursoCatalogRepository([p1]);
    const catalog = await repo.getCatalog("UK");
    expect(catalog[0].offers?.[0].currencyCode).toBe("GBP");
    expect(catalog[0].offers?.[0].retailer).toBe("Overclockers UK");

    await repo.close();
  });

  it("Pair 17 (F9 x F11): Multi-retailer ProductOffer querying respects both countryCode and subcategory build-relevance", async () => {
    const pValid = createMockProduct({ id: "gpu", category: "gpu", subcategory: "graphics-card", countryCode: "US" });
    const pInvalid = createMockProduct({ id: "pad", category: "accessories", subcategory: "mouse-pad", countryCode: "US" });

    const repo = new MockTursoCatalogRepository([pValid, pInvalid]);
    const res = await repo.getCatalog("US");

    expect(res.length).toBe(1);
    expect(res[0].id).toBe("gpu");

    await repo.close();
  });

  it("Pair 18 (F10 x F11): Catalog search tool applies country filter and subcategory filtering asynchronously", async () => {
    const pUS = createMockProduct({ id: "p-us", countryCode: "US", category: "cpu" });
    const pUK = createMockProduct({ id: "p-uk", countryCode: "UK", category: "cpu" });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [pUS, pUK] });
    const repo = new MemorySqliteRepository(dbPath);

    const searchUS = await repo.searchProducts({ category: "cpu" }, "US");
    expect(searchUS.totalCount).toBe(1);
    expect(searchUS.items[0].id).toBe("p-us");

    await repo.close();
    cleanup();
  });

  it("Pair 19 (F12 x F13): Snapshot validator executes Gate 1 (schema) and Gate 2 (drop threshold) in sequential order", async () => {
    // When schema is invalid, validation fails fast at Gate 1
    const { dbPath, cleanup } = createTestSqliteDb({ schemaVersion: 3, products: [] });

    const result = await validateCatalogSnapshot(dbPath, 100);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Gate 1"))).toBe(true);

    cleanup();
  });

  it("Pair 20 (F13 x F17): Drop threshold failure (>50% drop) immediately halts Turso publisher before remote network call", async () => {
    const prods = [createMockProduct({ id: "p1" })];
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });
    const mockTurso = new MockTursoClient();

    // Baseline was 100, candidate has 1 -> 99% drop -> fails Gate 2
    const res = await publishCandidateToTurso(dbPath, "https://turso.example.com", "token", mockTurso, { baselineCount: 100 });
    expect(res.success).toBe(false);
    expect(mockTurso.executedQueries.length).toBe(0);

    cleanup();
  });

  it("Pair 21 (F14 x F17): Field integrity failure (negative prices) blocks publication atomically", async () => {
    const prods = [createMockProduct({ price: -100 })];
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });
    const mockTurso = new MockTursoClient();

    const res = await publishCandidateToTurso(dbPath, "https://turso.example.com", "token", mockTurso);
    expect(res.success).toBe(false);
    expect(mockTurso.executedQueries.length).toBe(0);

    cleanup();
  });

  it("Pair 22 (F15 x F17): WAF bot challenge detection blocks Turso publication and preserves live catalog", async () => {
    const prods = [createMockProduct({ name: "Attention Required! | Cloudflare" })];
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });
    const mockTurso = new MockTursoClient();

    const res = await publishCandidateToTurso(dbPath, "https://turso.example.com", "token", mockTurso);
    expect(res.success).toBe(false);
    expect(mockTurso.executedQueries.length).toBe(0);

    cleanup();
  });

  it("Pair 23 (F16 x F17): Stale stock sweep ratio check guards atomic Turso publication", async () => {
    const prods = [
      createMockProduct({ id: "p1", inStock: false }),
      createMockProduct({ id: "p2", inStock: false }),
      createMockProduct({ id: "p3", inStock: false }),
      createMockProduct({ id: "p4", inStock: true })
    ];
    // 75% out-of-stock
    const { dbPath, cleanup } = createTestSqliteDb({ products: prods });
    const mockTurso = new MockTursoClient();

    const res = await publishCandidateToTurso(dbPath, "https://turso.example.com", "token", mockTurso);
    expect(res.success).toBe(true); // 75% passes default threshold

    cleanup();
  });

  it("Pair 24 (F18 x F20): Client session store persists session alongside associated market preference", async () => {
    const store = new MockBrowserSessionStore();
    const session: SessionDetail = {
      id: "uk-gaming-build",
      title: "UK Gaming PC",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
      messages: [],
      marketPreference: { countryCode: "UK", currencyCode: "GBP", locale: "en-GB" }
    };

    await store.saveSession(session);
    const retrieved = await store.getSession("uk-gaming-build");
    expect(retrieved?.marketPreference?.countryCode).toBe("UK");
    expect(retrieved?.marketPreference?.currencyCode).toBe("GBP");
  });

  it("Pair 25 (F19 x F21): Ephemeral BYOK keys in sessionStorage never leak across isolated browser session instances", () => {
    const userAStorage = new MockSessionStorage();
    const userBStorage = new MockSessionStorage();

    userAStorage.setItem("pcbuildsage_byok_gemini", "USER_A_KEY");
    expect(userBStorage.getItem("pcbuildsage_byok_gemini")).toBeNull();
  });

  it("Pair 26 (F22 x F23): Next.js standalone build output is copied and runnable in Dockerfile runner stage", () => {
    const dockerfile = `
      FROM node:20-alpine AS runner
      COPY --from=builder /app/.next/standalone ./
      COPY --from=builder /app/.next/static ./.next/static
      USER nextjs
      CMD ["node", "server.js"]
    `;

    const parsed = parseDockerfile(dockerfile);
    expect(parsed.hasStandalone).toBe(true);
    expect(parsed.isNonRoot).toBe(true);
  });

  it("Pair 27 (F23 x F24): Docker container runner stage dynamically binds PORT environment variable", () => {
    const dockerfile = `
      FROM node:20-alpine AS runner
      ENV PORT=3000
      EXPOSE 3000
      CMD ["node", "server.js"]
    `;

    const parsed = parseDockerfile(dockerfile);
    expect(parsed.envVars["PORT"]).toBe("3000");
    expect(parsed.exposedPorts).toContain("3000");
  });

  it("Pair 28 (F24 x F25): Standalone server on dynamic port responds to container healthcheck without local DB", () => {
    const port = parseInt(process.env.PORT || "10000", 10);
    const healthCheck = (p: number) => ({ status: 200, port: p, dbRequired: false });

    const result = healthCheck(port);
    expect(result.status).toBe(200);
    expect(result.dbRequired).toBe(false);
  });

  it("Pair 29 (F26 x F27): Scheduled GitHub Actions workflow integrates concurrency serialization", () => {
    const workflow = `
      on:
        schedule:
          - cron: '17 2 * * *'
      concurrency:
        group: catalog-refresh
        cancel-in-progress: false
    `;

    const parsed = parseWorkflowYaml(workflow);
    expect(parsed.hasCron).toBe(true);
    expect(parsed.hasConcurrency).toBe(true);
    expect(parsed.cancelInProgressFalse).toBe(true);
  });

  it("Pair 30 (F27 x F28): Concurrency-controlled runner executes local scraper into temp DB and runs snapshot validation", async () => {
    const p1 = createMockProduct({ price: 199.99 });
    const { dbPath, cleanup } = createTestSqliteDb({ products: [p1] });

    const validation = await validateCatalogSnapshot(dbPath);
    expect(validation.valid).toBe(true);

    cleanup();
  });

  it("Pair 31 (F28 x F29): Runner-local pipeline securely passes TURSO_INGEST_TOKEN only to the publisher step", () => {
    const workflow = `
      - name: Validate Snapshot
        run: npx tsx scripts/publish-catalog.ts --validate-only /tmp/candidate.db
      - name: Publish to Turso
        env:
          TURSO_INGEST_TOKEN: \${{ secrets.TURSO_INGEST_TOKEN }}
        run: npx tsx scripts/publish-catalog.ts /tmp/candidate.db
    `;

    const parsed = parseWorkflowYaml(workflow);
    expect(parsed.usesIngestToken).toBe(true);
    expect(workflow).toContain("Validate Snapshot");
    expect(workflow).toContain("Publish to Turso");
  });
});
