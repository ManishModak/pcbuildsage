/**
 * Track Q focused coverage for hosted hardening (real modules only).
 *
 * Replaces the deleted fake suites under tests/e2e/* (which asserted against
 * tests/e2e/test-harness.ts re-implementations). See deleted-file mapping in
 * the final Track Q summary; each behaviour below names the real module under
 * test. No new dependencies.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ALLOWED_HOSTED_ROUTES,
  checkChatPayloadSize,
  checkHostedRateLimit,
  getClientIpForRateLimit,
  HOSTED_CHAT_MAX_BODY_BYTES,
  isHostedSearchProviderAllowed,
  isRouteAllowedInHostedMode,
  isRouteBlockedInHostedMode,
  resetHostedRateLimitsForTesting
} from "@/lib/config/deployment";
import { GET as getHealth } from "@/app/api/health/route";
import { setCatalogRepository } from "@/lib/catalog";

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

describe("hosted search provider policy (no keyless DuckDuckGo)", () => {
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
});

describe("chat payload limits", () => {
  it("accepts a small payload", () => {
    expect(
      checkChatPayloadSize({ messages: [{ role: "user", content: "hello" }] }).allowed
    ).toBe(true);
  });

  it("rejects oversized bodies, too many messages, and oversized messages", () => {
    expect(
      checkChatPayloadSize({ messages: [], padding: "x".repeat(HOSTED_CHAT_MAX_BODY_BYTES + 1) }).allowed
    ).toBe(false);
    expect(
      checkChatPayloadSize({ messages: Array.from({ length: 101 }, () => ({ role: "user", content: "hi" })) }).allowed
    ).toBe(false);
    expect(
      checkChatPayloadSize({ messages: [{ role: "user", content: "x".repeat(100_001) }] }).allowed
    ).toBe(false);
  });
});

describe("GET /api/health catalog check", () => {
  const originalMode = process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
  const originalUrl = process.env.TURSO_DATABASE_URL;
  afterEach(() => {
    if (originalMode !== undefined) process.env.PCBUILDSAGE_DEPLOYMENT_MODE = originalMode;
    else delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
    if (originalUrl !== undefined) process.env.TURSO_DATABASE_URL = originalUrl;
    else delete process.env.TURSO_DATABASE_URL;
    setCatalogRepository(null);
  });

  it("reports reachable:false in hosted mode when the catalog is unconfigured", async () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    delete process.env.TURSO_DATABASE_URL;
    setCatalogRepository(null);
    const res = await getHealth();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; mode: string; catalog: { reachable: boolean } };
    expect(body.status).toBe("ok");
    expect(body.mode).toBe("hosted-demo");
    expect(body.catalog.reachable).toBe(false);
  });

  it("reports productCount via a cheap getFreshness call when reachable", async () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    setCatalogRepository({
      getCatalog: async () => { throw new Error("unused"); },
      searchProducts: async () => { throw new Error("unused"); },
      listModels: async () => { throw new Error("unused"); },
      getCategoryBaseline: async () => { throw new Error("unused"); },
      getFreshness: async () => ({ lastScraped: "2026-01-01T00:00:00Z", productCount: 42 })
    } as never);
    const res = await getHealth();
    const body = (await res.json()) as { catalog: { reachable: boolean; productCount: number } };
    expect(body.catalog.reachable).toBe(true);
    expect(body.catalog.productCount).toBe(42);
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
});
