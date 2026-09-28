/**
 * src/app/api/metrics/route.ts
 *
 * Anonymous client-event intake. Accepts ONLY the allow-listed browser events
 * {landing_view, onboarding_completed}; everything else is rejected with 400.
 * Counts land in the same daily_counts buffer as server events. Per-IP
 * buckets below are an in-memory rate limiter only — IPs are NEVER written
 * to the analytics database. No-op in local mode (local counts nothing).
 */

import { z } from "zod";
import { getClientIpForRateLimit, getDeploymentMode } from "@/lib/config/deployment";
import { CLIENT_ANALYTICS_EVENTS } from "@/lib/analytics/events";
import { flushInBackground, record } from "@/lib/analytics/store";

export const runtime = "nodejs";

const metricsBodySchema = z.object({ event: z.enum(CLIENT_ANALYTICS_EVENTS) }).strict();

export const METRICS_RATE_LIMIT_MAX_REQUESTS = 30;
export const METRICS_RATE_LIMIT_WINDOW_MS = 60_000;
const METRICS_RATE_LIMIT_MAX_BUCKETS = 5_000;

const buckets = new Map<string, { count: number; resetAt: number }>();

export function resetMetricsRateLimitsForTesting(): void {
  buckets.clear();
}

function checkMetricsRateLimit(ip: string, now: number = Date.now()): boolean {
  const key = (ip || "unknown").trim().toLowerCase() || "unknown";
  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    if (bucket) buckets.delete(key);
    while (buckets.size >= METRICS_RATE_LIMIT_MAX_BUCKETS) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
    buckets.set(key, { count: 1, resetAt: now + METRICS_RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (bucket.count < METRICS_RATE_LIMIT_MAX_REQUESTS) {
    bucket.count += 1;
    return true;
  }
  return false;
}

export async function POST(request: Request): Promise<Response> {
  if (getDeploymentMode() !== "hosted-demo") {
    return Response.json({ ok: true, disabled: true });
  }
  if (!checkMetricsRateLimit(getClientIpForRateLimit(request.headers))) {
    return Response.json(
      { ok: false, error: "rate_limited", message: "Rate limit exceeded. Please retry shortly." },
      { status: 429 }
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, error: "invalid_json", message: "Request body must be JSON." },
      { status: 400 }
    );
  }
  const parsed = metricsBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: "unknown_event", message: "Unknown metric event." },
      { status: 400 }
    );
  }
  try {
    record(parsed.data.event, "");
  } catch {
    // record() never throws; belt-and-braces so intake stays 200.
  }
  flushInBackground();
  return Response.json({ ok: true });
}
