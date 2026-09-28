/**
 * src/app/api/metrics/route.ts
 *
 * Anonymous client-event intake. Accepts ONLY the allow-listed browser events
 * {landing_view, onboarding_completed}; everything else is rejected with 400.
 * Counts land in the same daily_counts buffer as server events. Per-IP
 * buckets (lib/analytics/rate-limit.ts) are an in-memory rate limiter only — IPs are NEVER written
 * to the analytics database. No-op in local mode (local counts nothing).
 */

import { z } from "zod";
import { getClientIpForRateLimit, getDeploymentMode } from "@/lib/config/deployment";
import { CLIENT_ANALYTICS_EVENTS } from "@/lib/analytics/events";
import { flushInBackground, record } from "@/lib/analytics/store";
import { checkMetricsRateLimit } from "@/lib/analytics/rate-limit";

export const runtime = "nodejs";

const metricsBodySchema = z.object({ event: z.enum(CLIENT_ANALYTICS_EVENTS) }).strict();

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
