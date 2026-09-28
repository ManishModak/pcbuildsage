/**
 * Track Q focused coverage for hosted hardening (real modules only).
 *
 * Replaces the deleted fake suites under tests/e2e/* (which asserted against
 * tests/e2e/test-harness.ts re-implementations). See deleted-file mapping in
 * the final Track Q summary; each behaviour below names the real module under
 * test. No new dependencies.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  ALLOWED_HOSTED_ROUTES,
  checkChatPayloadSize,
  checkHostedRateLimit,
  exceedsHostedChatBodyLimit,
  getClientIpForRateLimit,
  HOSTED_CHAT_MAX_BODY_BYTES,
  HOSTED_CHAT_MAX_MESSAGES,
  HOSTED_CHAT_MAX_USER_TEXT_CHARS,
  HOSTED_RATE_LIMIT_MAX_BUCKETS,
  hostedRateBucketCountForTesting,
  isHostedSearchProviderAllowed,
  isRouteAllowedInHostedMode,
  isRouteBlockedInHostedMode,
  resetHostedRateLimitsForTesting
} from "@/lib/config/deployment";
import { assertSafeSearchConfig, buildAppConfig, UnsafeConfigError } from "@/app/api/_lib/credentials";
import { middleware } from "@/middleware";

const root = path.resolve(__dirname, "..");

describe("hosted allowlist (default-deny)", () => {
  it("permits listed public routes", () => {
    for (const route of ["/api/health", "/api/status", "/api/markets", "/api/chat", "/api/chat/compact"]) {
      expect(isRouteAllowedInHostedMode(route, "GET", "hosted-demo")).toBe(true);
    }
    expect(isRouteAllowedInHostedMode("/api/chat", "POST", "hosted-demo")).toBe(true);
    expect(isRouteAllowedInHostedMode("/api/chat/compact", "POST", "hosted-demo")).toBe(true);
  });

  it("denies admin routes and unknown /api paths", () => {
    for (const route of ["/api/scrape", "/api/profiles", "/api/profiles/import", "/api/logs", "/api/sessions", "/api/export-research", "/api/admin"]) {
      expect(isRouteAllowedInHostedMode(route, "GET", "hosted-demo")).toBe(false);
      expect(isRouteAllowedInHostedMode(route, "POST", "hosted-demo")).toBe(false);
    }
  });

  it("normalizes encoded and traversal bypasses before deciding", () => {
    expect(isRouteAllowedInHostedMode("/api/%73crape", "POST", "hosted-demo")).toBe(false);
    expect(isRouteAllowedInHostedMode("/api/../api/scrape", "POST", "hosted-demo")).toBe(false);
    expect(isRouteAllowedInHostedMode("/api/health?x=1", "GET", "hosted-demo")).toBe(true);
  });

  it("allows everything in local mode", () => {
    expect(isRouteAllowedInHostedMode("/api/scrape", "POST", "local")).toBe(true);
    expect(isRouteAllowedInHostedMode("/api/anything", "GET", "local")).toBe(true);
  });

  it("legacy blocklist still flags known dangerous routes", () => {
    expect(isRouteBlockedInHostedMode("/api/scrape", "POST", "hosted-demo")).toBe(true);
    expect(isRouteBlockedInHostedMode("/api/health", "GET", "hosted-demo")).toBe(false);
  });

  it("allowlist covers the documented public surface", () => {
    const paths = ALLOWED_HOSTED_ROUTES.map((r) => r.path);
    for (const p of ["/api/health", "/api/status", "/api/markets", "/api/chat", "/api/chat/compact"]) {
      expect(paths).toContain(p);
    }
  });
});

describe("hosted per-IP rate limit (reusable via checkHostedRateLimit)", () => {
  afterEach(() => resetHostedRateLimitsForTesting());

  it("allows a burst then rejects with retryAfterMs", () => {
    resetHostedRateLimitsForTesting();
    const now = Date.now();
    for (let i = 0; i < 60; i++) {
      expect(checkHostedRateLimit("1.2.3.4", now, { maxRequests: 60, windowMs: 60_000 }).allowed).toBe(true);
    }
    const limited = checkHostedRateLimit("1.2.3.4", now, { maxRequests: 60, windowMs: 60_000 });
    expect(limited.allowed).toBe(false);
    expect(limited.retryAfterMs).toBeGreaterThan(0);
  });

  it("isolates buckets per IP and resets after the window", () => {
    const now = Date.now();
    for (let i = 0; i < 2; i++) {
      checkHostedRateLimit("10.0.0.1", now, { maxRequests: 2, windowMs: 1000 });
    }
    expect(checkHostedRateLimit("10.0.0.1", now, { maxRequests: 2, windowMs: 1000 }).allowed).toBe(false);
    expect(checkHostedRateLimit("10.0.0.2", now, { maxRequests: 2, windowMs: 1000 }).allowed).toBe(true);
    expect(checkHostedRateLimit("10.0.0.1", now + 1001, { maxRequests: 2, windowMs: 1000 }).allowed).toBe(true);
  });

  it("extracts client IP from proxy headers", () => {
    expect(getClientIpForRateLimit(new Headers({ "x-forwarded-for": "9.9.9.9, 1.1.1.1" }))).toBe("9.9.9.9");
    expect(getClientIpForRateLimit(new Headers({ "x-real-ip": "8.8.8.8" }))).toBe("8.8.8.8");
    expect(getClientIpForRateLimit(new Headers())).toBe("unknown");
  });
});

describe("hosted rate limit memory and exemptions", () => {
  const originalMode = process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
  afterEach(() => {
    resetHostedRateLimitsForTesting();
    if (originalMode !== undefined) process.env.PCBUILDSAGE_DEPLOYMENT_MODE = originalMode;
    else delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
  });

  it("sweeps expired buckets once a window has passed", () => {
    resetHostedRateLimitsForTesting();
    const opts = { maxRequests: 5, windowMs: 1000 };
    for (let i = 0; i < 50; i++) checkHostedRateLimit(`10.1.0.${i}`, 0, opts);
    expect(hostedRateBucketCountForTesting()).toBe(50);
    checkHostedRateLimit("10.2.0.1", 1001, opts);
    expect(hostedRateBucketCountForTesting()).toBe(1);
  });

  it("caps live buckets at HOSTED_RATE_LIMIT_MAX_BUCKETS", () => {
    resetHostedRateLimitsForTesting();
    const opts = { maxRequests: 5, windowMs: 60_000 };
    for (let i = 0; i < HOSTED_RATE_LIMIT_MAX_BUCKETS + 50; i++) checkHostedRateLimit(`ip-${i}`, 0, opts);
    expect(hostedRateBucketCountForTesting()).toBeLessThanOrEqual(HOSTED_RATE_LIMIT_MAX_BUCKETS);
  });

  it("never rate-limits /api/health in hosted mode", () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    resetHostedRateLimitsForTesting();
    const headers = { "x-forwarded-for": "7.7.7.7" };
    for (let i = 0; i < 60; i++) {
      middleware(new NextRequest("https://demo.example/api/status", { headers }));
    }
    expect(middleware(new NextRequest("https://demo.example/api/status", { headers })).status).toBe(429);
    for (let i = 0; i < 100; i++) {
      expect(middleware(new NextRequest("https://demo.example/api/health", { headers })).status).not.toBe(429);
    }
  });
});

describe("hosted search provider policy (no keyless DuckDuckGo)", () => {
  const originalMode = process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
  afterEach(() => {
    if (originalMode !== undefined) process.env.PCBUILDSAGE_DEPLOYMENT_MODE = originalMode;
    else delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
  });

  it("blocks duckduckgo and searxng in hosted mode, allows keyed providers", () => {
    expect(isHostedSearchProviderAllowed("duckduckgo", "hosted-demo")).toBe(false);
    expect(isHostedSearchProviderAllowed("searxng", "hosted-demo")).toBe(false);
    for (const p of ["exa", "tavily", "brave", "gemini-native", "none"]) {
      expect(isHostedSearchProviderAllowed(p, "hosted-demo")).toBe(true);
    }
  });

  it("allows everything in local mode", () => {
    expect(isHostedSearchProviderAllowed("duckduckgo", "local")).toBe(true);
    expect(isHostedSearchProviderAllowed("searxng", "local")).toBe(true);
  });

  it("coerces keyless, self-hosted and key-less keyed providers to none", () => {
    for (const provider of ["duckduckgo", "searxng", "tavily", "exa", "brave"] as const) {
      const safe = assertSafeSearchConfig({ provider, baseUrl: "http://127.0.0.1:8080", crawlEnabled: false }, "hosted-demo");
      expect(safe.provider).toBe("none");
      expect(safe.baseUrl).toBeUndefined();
    }
  });

  it("keeps keyed providers that carry a key, and gemini-native", () => {
    expect(assertSafeSearchConfig({ provider: "tavily", apiKey: "k", crawlEnabled: false }, "hosted-demo").provider).toBe("tavily");
    expect(assertSafeSearchConfig({ provider: "gemini-native", crawlEnabled: false }, "hosted-demo").provider).toBe("gemini-native");
    expect(() =>
      assertSafeSearchConfig({ provider: "brave", apiKey: "k", baseUrl: "http://169.254.169.254", crawlEnabled: false }, "hosted-demo")
    ).toThrow(UnsafeConfigError);
  });

  it("a raw hosted request with no searchProvider (default duckduckgo) resolves to none", () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    const config = buildAppConfig(new Headers(), {
      llmChain: [{ provider: "gemini", model: "gemini-2.5-flash", keySource: "none" }]
    });
    expect(config.search.provider).toBe("none");
  });

  it("leaves local mode untouched", () => {
    expect(assertSafeSearchConfig({ provider: "duckduckgo", crawlEnabled: false }, "local").provider).toBe("duckduckgo");
  });
});

describe("chat payload limits (hosted-demo only, sized for real sessions)", () => {
  const userMsg = (text: string) => ({ role: "user", parts: [{ type: "text", text }] });
  const assistantMsg = (chars: number) => ({
    role: "assistant",
    parts: [
      { type: "text", text: "Here is your build." },
      { type: "tool-search_catalog", state: "output-available", output: { rows: "x".repeat(chars) } }
    ]
  });

  it("accepts large assistant/tool messages (real ones reach ~450k chars)", () => {
    const body = { messages: [userMsg("build me a PC"), assistantMsg(450_000), userMsg("cheaper please")] };
    expect(checkChatPayloadSize(body, "hosted-demo").allowed).toBe(true);
  });

  it("caps only user-typed text per message", () => {
    expect(checkChatPayloadSize({ messages: [userMsg("x".repeat(HOSTED_CHAT_MAX_USER_TEXT_CHARS))] }, "hosted-demo").allowed).toBe(true);
    expect(checkChatPayloadSize({ messages: [userMsg("x".repeat(HOSTED_CHAT_MAX_USER_TEXT_CHARS + 1))] }, "hosted-demo").allowed).toBe(false);
    expect(checkChatPayloadSize({ messages: [{ role: "user", content: "x".repeat(HOSTED_CHAT_MAX_USER_TEXT_CHARS + 1) }] }, "hosted-demo").allowed).toBe(false);
  });

  it("caps message count and body bytes", () => {
    const many = (n: number) => ({ messages: Array.from({ length: n }, () => userMsg("hi")) });
    expect(checkChatPayloadSize(many(HOSTED_CHAT_MAX_MESSAGES), "hosted-demo").allowed).toBe(true);
    expect(checkChatPayloadSize(many(HOSTED_CHAT_MAX_MESSAGES + 1), "hosted-demo").allowed).toBe(false);
    // Multi-byte text: under the cap in chars, over it in UTF-8 bytes.
    const big = { messages: [assistantMsg(0)], padding: "₹".repeat(Math.ceil(HOSTED_CHAT_MAX_BODY_BYTES / 3) + 10) };
    expect(checkChatPayloadSize(big, "hosted-demo").allowed).toBe(false);
  });

  it("applies no caps in local mode", () => {
    const huge = { messages: [userMsg("x".repeat(HOSTED_CHAT_MAX_USER_TEXT_CHARS * 2)), assistantMsg(HOSTED_CHAT_MAX_BODY_BYTES + 1)] };
    expect(checkChatPayloadSize(huge, "local").allowed).toBe(true);
    const headers = new Headers({ "content-length": String(HOSTED_CHAT_MAX_BODY_BYTES + 1) });
    expect(exceedsHostedChatBodyLimit(headers, "local")).toBe(false);
    expect(exceedsHostedChatBodyLimit(headers, "hosted-demo")).toBe(true);
  });

  // Uses the local session store when present (read-only); override the path
  // with PCBUILDSAGE_SESSIONS_DB. Skipped on CI/fresh clones.
  const dbPath = [process.env.PCBUILDSAGE_SESSIONS_DB, path.join(root, "data/sessions.db")]
    .find((p): p is string => Boolean(p) && fs.existsSync(p!));
  it.skipIf(!dbPath)("accepts the largest real saved session", async (ctx) => {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(dbPath as string, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT messages FROM sessions ORDER BY length(messages) DESC LIMIT 1").get() as
        | { messages: string }
        | undefined;
      if (!row) return ctx.skip();
      const messages = JSON.parse(row.messages) as unknown[];
      const next = [...messages, userMsg("Can you make it cheaper?")];
      expect(checkChatPayloadSize({ messages: next }, "hosted-demo")).toEqual({ allowed: true });
    } finally {
      db.close();
    }
  });
});

describe("GET /api/health catalog ping", () => {
  const originalMode = process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
  const originalUrl = process.env.TURSO_DATABASE_URL;
  afterEach(() => {
    vi.useRealTimers();
    if (originalMode !== undefined) process.env.PCBUILDSAGE_DEPLOYMENT_MODE = originalMode;
    else delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
    if (originalUrl !== undefined) process.env.TURSO_DATABASE_URL = originalUrl;
    else delete process.env.TURSO_DATABASE_URL;
  });

  // Fresh module graph per test: the route caches its repository per process.
  async function freshHealth() {
    vi.resetModules();
    const catalog = await import("@/lib/catalog");
    const route = await import("@/app/api/health/route");
    return { catalog, getHealth: route.GET };
  }

  function fakeRepo(execute: (sql: string) => Promise<unknown>) {
    const fail = async () => { throw new Error("health must not run catalog queries"); };
    return {
      client: { execute: vi.fn(execute) },
      getCatalog: fail, searchProducts: fail, listModels: fail, getCategoryBaseline: fail, getFreshness: fail
    };
  }

  it("returns 200 degraded when the catalog is unconfigured", async () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    delete process.env.TURSO_DATABASE_URL;
    const { getHealth } = await freshHealth();
    const res = await getHealth();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; mode: string; catalog: { reachable: boolean } };
    expect(body).toMatchObject({ status: "degraded", mode: "hosted-demo", catalog: { reachable: false } });
  });

  it("pings with a trivial LIMIT 1 query and reuses one repository", async () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    const { catalog, getHealth } = await freshHealth();
    const repo = fakeRepo(async () => ({ rows: [] }));
    const factory = vi.fn(() => repo as never);
    catalog.registerCatalogRepository("hosted-demo", factory);
    for (let i = 0; i < 3; i++) {
      const res = await getHealth();
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "ok", catalog: { reachable: true } });
    }
    expect(factory).toHaveBeenCalledTimes(1);
    expect(repo.client.execute).toHaveBeenCalledTimes(3);
    expect(repo.client.execute.mock.calls[0]?.[0]).toMatch(/^SELECT 1 .*LIMIT 1$/);
  });

  it("times out a hung catalog within ~2s and reports degraded", async () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    const { catalog, getHealth } = await freshHealth();
    catalog.setCatalogRepository(fakeRepo(() => new Promise(() => {})) as never);
    vi.useFakeTimers();
    const pending = getHealth();
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "degraded", catalog: { reachable: false } });
  });
});

describe("hosted setup wiring (Node 22, permissions, Turso docs)", () => {
  it("pins Node 22 in Docker and the refresh workflow", () => {
    const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf-8");
    expect(dockerfile).toMatch(/FROM\s+node:22-bookworm-slim\s+AS\s+deps/i);
    expect(dockerfile).toMatch(/FROM\s+node:22-bookworm-slim\s+AS\s+runner/i);
    expect(dockerfile).not.toMatch(/node:20-bookworm-slim/);
    const refresh = fs.readFileSync(path.join(root, ".github/workflows/refresh-catalog.yml"), "utf-8");
    expect(refresh).toContain('node-version: "22"');
    expect(refresh).not.toContain('node-version: "20"');
  });

  it("restricts workflow permissions to contents:read", () => {
    for (const file of ["ci.yml", "refresh-catalog.yml"]) {
      const raw = fs.readFileSync(path.join(root, ".github/workflows", file), "utf-8");
      expect(raw).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    }
  });

  it("documents Turso vars and Render health check", () => {
    const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf-8");
    for (const name of ["TURSO_DATABASE_URL", "TURSO_READ_TOKEN", "TURSO_INGEST_TOKEN"]) {
      expect(envExample).toContain(name);
    }
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf-8");
    expect(readme).toContain("TURSO_DATABASE_URL");
    expect(readme).toContain("/api/health");
    expect(fs.existsSync(path.join(root, "render.yaml"))).toBe(true);
    const render = fs.readFileSync(path.join(root, "render.yaml"), "utf-8");
    expect(render).toContain("healthCheckPath: /api/health");
    expect(render).toContain("TURSO_READ_TOKEN");
  });

  it("stays on free tiers and keeps the hosted-demo README promises", () => {
    const render = fs.readFileSync(path.join(root, "render.yaml"), "utf-8");
    expect(render).toMatch(/^\s*plan:\s*free\s*$/m);
    expect(render).toMatch(/make `name` and `region` below match/);
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf-8");
    expect(readme).not.toMatch(/\b(starter|standard|pro) plan\b|Plan:\*\*\s*Starter/i);
    for (const text of [
      "pcbuildsage.onrender.com",
      "**India catalog**",
      "**Bring your own key.**",
      "**Your key stays in your browser.**",
      "Deploy your own (free tier: Render + Turso)"
    ]) {
      expect(readme).toContain(text);
    }
  });
});
