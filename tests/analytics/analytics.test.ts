/**
 * Track G4 challenger tests: anonymous analytics (hosted only).
 *
 * - /api/metrics rejects unknown events (400) and accepts allow-listed ones.
 * - Chat still works with the analytics DB unreachable (record/flush resolve).
 * - Schema has no ip/message/user-id/session-id/user-agent/url field.
 * - Local mode writes nothing (no client construction, no writes).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  execute: vi.fn(async () => ({ rows: [] })),
  batch: vi.fn(async () => [])
}));

vi.mock("@libsql/client", () => ({
  createClient: (...args: unknown[]) => {
    mocks.createClient(...args);
    return { execute: mocks.execute, batch: mocks.batch, close: vi.fn() };
  }
}));

import { POST } from "@/app/api/metrics/route";
import { resetMetricsRateLimitsForTesting } from "@/lib/analytics/rate-limit";
import {
  ANALYTICS_UPSERT_SQL,
  classifyErrorType,
  DAILY_COUNTS_DDL,
  sanitizeDimension,
  sanitizeProviderDimension
} from "@/lib/analytics/events";
import {
  flush,
  record,
  resetAnalyticsForTesting,
  setAnalyticsClientFactoryForTesting,
  snapshotBufferForTesting
} from "@/lib/analytics/store";
import { isRouteAllowedInHostedMode } from "@/lib/config/deployment";

const ORIGINAL_ENV = { ...process.env };

function setEnv(mode: string | undefined, analyticsConfigured: boolean) {
  if (mode === undefined) delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
  else process.env.PCBUILDSAGE_DEPLOYMENT_MODE = mode;
  if (analyticsConfigured) {
    process.env.ANALYTICS_TURSO_URL = "libsql://analytics.test";
    process.env.ANALYTICS_TURSO_TOKEN = "test-token";
  } else {
    delete process.env.ANALYTICS_TURSO_URL;
    delete process.env.ANALYTICS_TURSO_TOKEN;
  }
}

function metricsRequest(body: unknown, ip = "9.9.9.9"): Request {
  return new Request("https://demo.example/api/metrics", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

function fakeClient(executeImpl?: () => Promise<unknown>): Client {
  return {
    execute: (executeImpl ?? mocks.execute) as Client["execute"],
    batch: mocks.batch as unknown as Client["batch"],
    close: (() => {}) as Client["close"]
  } as Client;
}

beforeEach(() => {
  resetAnalyticsForTesting();
  resetMetricsRateLimitsForTesting();
  mocks.createClient.mockClear();
  mocks.execute.mockClear();
  mocks.batch.mockClear();
});

afterEach(() => {
  resetAnalyticsForTesting();
  resetMetricsRateLimitsForTesting();
  for (const key of ["PCBUILDSAGE_DEPLOYMENT_MODE", "ANALYTICS_TURSO_URL", "ANALYTICS_TURSO_TOKEN"]) {
    if (ORIGINAL_ENV[key] !== undefined) process.env[key] = ORIGINAL_ENV[key];
    else delete process.env[key];
  }
  vi.useRealTimers();
});

describe("/api/metrics validation", () => {
  it("accepts allow-listed client events", async () => {
    setEnv("hosted-demo", true);
    for (const event of ["landing_view", "onboarding_completed"]) {
      const res = await POST(metricsRequest({ event }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });
    }
    await flush({ force: true });
    expect(mocks.batch).toHaveBeenCalled();
  });

  it("rejects unknown, server-side, malformed, and extra-key bodies with 400", async () => {
    setEnv("hosted-demo", true);
    for (const body of [
      { event: "hacked" },
      { event: "chat_started" },
      { event: "provider_used" },
      { event: "landing_view", extra: 1 },
      {},
      { event: 42 }
    ]) {
      const res = await POST(metricsRequest(body));
      expect(res.status).toBe(400);
    }
    expect((await POST(metricsRequest("not-json", "9.9.9.9"))).status).toBe(400);
  });

  it("is a no-op success in local mode (local counts nothing)", async () => {
    setEnv("local", true);
    const res = await POST(metricsRequest({ event: "landing_view" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, disabled: true });
    expect(snapshotBufferForTesting()).toHaveLength(0);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("rate-limits per IP in memory without storing IPs in the DB", async () => {
    setEnv("hosted-demo", true);
    for (let i = 0; i < 30; i++) {
      expect((await POST(metricsRequest({ event: "landing_view" }))).status).toBe(200);
    }
    const limited = await POST(metricsRequest({ event: "landing_view" }));
    expect(limited.status).toBe(429);
    // Same event from a different bucket still passes.
    expect((await POST(metricsRequest({ event: "landing_view" }, "8.8.8.8"))).status).toBe(200);
    await flush({ force: true });
    const wrote = (mocks.batch.mock.calls as unknown[][]).flatMap((c) => (c[0] as unknown[]));
    for (const stmt of wrote) {
      expect(JSON.stringify(stmt)).not.toMatch(/9\.9\.9\.9|8\.8\.8\.8/);
    }
  });

  it("is reachable via POST only through the hosted allowlist", () => {
    expect(isRouteAllowedInHostedMode("/api/metrics", "POST", "hosted-demo")).toBe(true);
    expect(isRouteAllowedInHostedMode("/api/metrics", "GET", "hosted-demo")).toBe(false);
  });
});

describe("analytics store resilience", () => {
  it("record + flush resolve with an unreachable analytics DB (chat unaffected)", async () => {
    setEnv("hosted-demo", true);
    setAnalyticsClientFactoryForTesting(() =>
      fakeClient(async () => {
        throw new Error("BLOCKED");
      })
    );
    expect(() => {
      record("chat_started", "");
      record("provider_used", "gemini:gemini-2.5-flash");
      record("error_type", "upstream");
    }).not.toThrow();
    await expect(flush({ force: true })).resolves.toBeUndefined();
    await expect(flush({ force: true })).resolves.toBeUndefined();
  });

  it("resolves with no analytics env configured (never falls back to catalog vars)", async () => {
    setEnv("hosted-demo", false);
    process.env.TURSO_DATABASE_URL = "libsql://catalog.test";
    process.env.TURSO_READ_TOKEN = "catalog-token";
    expect(() => record("chat_started", "")).not.toThrow();
    await expect(flush({ force: true })).resolves.toBeUndefined();
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(snapshotBufferForTesting()).toHaveLength(1);
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_READ_TOKEN;
  });

  it("ignores events outside the allow-list", () => {
    setEnv("hosted-demo", true);
    record("totally_made_up", "");
    record("", "");
    expect(snapshotBufferForTesting()).toHaveLength(0);
  });

  it("upserts one row per (day, event, dimension)", async () => {
    setEnv("hosted-demo", true);
    setAnalyticsClientFactoryForTesting(() => fakeClient());
    record("chat_started", "");
    record("chat_started", "");
    record("provider_used", "gemini:gemini-2.5-flash");
    await flush({ force: true });
    expect(mocks.execute).toHaveBeenCalledWith(DAILY_COUNTS_DDL);
    const statements = (mocks.batch.mock.calls as unknown[][])[0]?.[0] as unknown as Array<{
      sql: string;
      args: unknown[];
    }>;
    expect(statements).toHaveLength(2);
    for (const stmt of statements) expect(stmt.sql).toBe(ANALYTICS_UPSERT_SQL);
    const chat = statements.find((s) => s.args[1] === "chat_started");
    expect(chat?.args[3]).toBe(2);
    expect(snapshotBufferForTesting()).toHaveLength(0);
  });
});

describe("local mode writes nothing", () => {
  it("record buffers nothing and flush constructs no client", async () => {
    setEnv("local", true);
    record("chat_started", "");
    record("build_presented", "");
    record("landing_view", "");
    expect(snapshotBufferForTesting()).toHaveLength(0);
    await flush({ force: true });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it("also stays silent when the mode var is unset (defaults to local)", async () => {
    setEnv(undefined, true);
    record("chat_started", "");
    expect(snapshotBufferForTesting()).toHaveLength(0);
    await flush({ force: true });
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});

describe("schema privacy contract", () => {
  it("daily_counts holds day-granularity counters only", () => {
    expect(DAILY_COUNTS_DDL).toMatch(/CREATE TABLE IF NOT EXISTS daily_counts/);
    expect(DAILY_COUNTS_DDL).toMatch(/PRIMARY KEY\s*\(\s*day\s*,\s*event\s*,\s*dimension\s*\)/);
    const lowered = DAILY_COUNTS_DDL.toLowerCase();
    for (const forbidden of ["message", "user-id", "session-id", "user-agent"]) {
      expect(lowered).not.toContain(forbidden);
    }
    expect(lowered).not.toMatch(/\bip\b/);
    expect(lowered).not.toMatch(/\burl\b/);
    expect(lowered).not.toMatch(/\buser\b/);
    expect(lowered).not.toMatch(/\bsession\b/);
  });
});

describe("sanitizers", () => {
  it("strips everything but coarse labels from dimensions", () => {
    expect(sanitizeProviderDimension("gemini", "gemini-2.5-flash")).toBe("gemini:gemini-2.5-flash");
    expect(sanitizeDimension("sk-or-v1-abc DEF")).toBe("sk-or-v1-abcdef");
    expect(sanitizeDimension("AIzaSySecretKey!!")).toBe("aizasysecretkey");
    expect(sanitizeDimension(undefined)).toBe("");
  });

  it("classifies errors without leaking raw text", () => {
    expect(classifyErrorType({ status: 401 })).toBe("auth");
    expect(classifyErrorType({ statusCode: 429 })).toBe("rate_limit");
    expect(classifyErrorType({ status: 500 })).toBe("upstream");
    expect(classifyErrorType(Object.assign(new Error("x"), { name: "ZodError" }))).toBe("bad_request");
    const secret = new Error("key=AIzaSySecret123 quota exceeded?");
    expect(classifyErrorType(secret)).not.toContain("AIzaSySecret123");
    expect(classifyErrorType(new Error("boom"))).toBe("unknown");
  });
});
