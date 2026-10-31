/**
 * In-memory per-IP rate limiter for /api/metrics. IPs live only in this
 * process-local map and are NEVER written to the analytics database.
 * Kept out of the route file because Next.js route modules may only export
 * route handlers and config.
 */

export const METRICS_RATE_LIMIT_MAX_REQUESTS = 30;
export const METRICS_RATE_LIMIT_WINDOW_MS = 60_000;
const METRICS_RATE_LIMIT_MAX_BUCKETS = 5_000;

const buckets = new Map<string, { count: number; resetAt: number }>();

export function resetMetricsRateLimitsForTesting(): void {
  buckets.clear();
}

/** Returns true when this IP may send another event in the current window. */
export function checkMetricsRateLimit(ip: string, now: number = Date.now()): boolean {
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
