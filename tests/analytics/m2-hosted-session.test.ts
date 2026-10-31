/**
 * tests/analytics/m2-hosted-session.test.ts
 *
 * M2 challenger: after ONE simulated hosted session touching every event,
 * `npm run analytics` (scripts/analytics.ts) shows each event. Uses a REAL
 * libsql file database (no client mocks — this file must stay mock-free) so
 * the record → buffer → flush → SELECT path is exercised end to end.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as metricsPOST } from "@/app/api/metrics/route";
import { resetMetricsRateLimitsForTesting } from "@/lib/analytics/rate-limit";
import { flush, record, resetAnalyticsForTesting } from "@/lib/analytics/store";
import { runAnalytics } from "../../scripts/analytics";

const ORIGINAL_ENV = { ...process.env };
let dbFile = "";

function metricsRequest(event: string): Request {
  return new Request("https://demo.example/api/metrics", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "10.1.2.3" },
    body: JSON.stringify({ event })
  });
}

beforeEach(() => {
  resetAnalyticsForTesting();
  resetMetricsRateLimitsForTesting();
  const dir = mkdtempSync(path.join(tmpdir(), "analytics-m2-"));
  dbFile = path.join(dir, "analytics.db");
  process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
  process.env.ANALYTICS_TURSO_URL = `file:${dbFile}`;
  process.env.ANALYTICS_TURSO_TOKEN = "dummy-token-for-file-backend";
});

afterEach(() => {
  resetAnalyticsForTesting();
  resetMetricsRateLimitsForTesting();
  for (const key of ["PCBUILDSAGE_DEPLOYMENT_MODE", "ANALYTICS_TURSO_URL", "ANALYTICS_TURSO_TOKEN"]) {
    if (ORIGINAL_ENV[key] !== undefined) process.env[key] = ORIGINAL_ENV[key];
    else delete process.env[key];
  }
  if (dbFile) rmSync(path.dirname(dbFile), { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("M2: one hosted session shows up in npm run analytics", () => {
  it("records all six events and prints them via the analytics script", async () => {
    // Client-counted events, exactly as the browser helper sends them.
    expect((await metricsPOST(metricsRequest("landing_view"))).status).toBe(200);
    expect((await metricsPOST(metricsRequest("onboarding_completed"))).status).toBe(200);
    // Server-counted events, as the chat route records them.
    record("chat_started", "");
    record("build_presented", "");
    record("provider_used", "gemini");
    record("error_type", "rate_limit");
    await flush({ force: true });

    const lines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      await expect(runAnalytics()).resolves.toBe(0);
    } finally {
      logSpy.mockRestore();
    }
    const output = lines.join("\n");
    for (const event of [
      "landing_view",
      "onboarding_completed",
      "chat_started",
      "build_presented",
      "provider_used",
      "error_type"
    ]) {
      expect(output).toContain(event);
    }
    expect(output).toContain("gemini");
  });
});
