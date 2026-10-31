#!/usr/bin/env tsx
/**
 * scripts/analytics.ts
 *
 * Prints the last 30 days of anonymous daily usage counts from the SEPARATE
 * analytics Turso database (ANALYTICS_TURSO_URL / ANALYTICS_TURSO_TOKEN).
 * Never touches the catalog TURSO_* vars. Read-only: a single SELECT.
 *
 * Usage: npm run analytics
 *
 * --- Turso free-tier findings (checked 2026-09-28 via turso.tech/pricing,
 * turso.tech/pricing.md, and the usage-and-billing help page) ---
 * - Free tier ($0, no card): 100 databases, 5 GB total storage, 500M rows
 *   read/month, 10M rows written/month, 3 GB monthly syncs, 1-day
 *   point-in-time restore, community support.
 * - Turso meters ROWS, not requests: each daily_counts upsert writes ~1 row.
 *   This design flushes at most a handful of (day, event, dimension) rows per
 *   minute, so even a busy demo day costs dozens of writes — ~6 orders of
 *   magnitude under the 10M writes/month ceiling, which is the quota a
 *   write-heavy app would hit first. The read here is one small SELECT.
 * - At the limit on the free plan (no overages): once ANY single metric
 *   (storage, rows read, rows written, syncs) is exceeded, databases are
 *   BLOCKED — queries fail with a BLOCKED error until quota resets or the
 *   project upgrades (Developer $4.99/mo: 2.5B reads, 25M writes, 9 GB).
 *   Paid plans with overages enabled instead keep serving and bill per unit.
 * - Safety consequence: analytics writes are best-effort and fully swallowed
 *   (see src/lib/analytics/store.ts), so a BLOCKED analytics DB degrades to
 *   "no counts recorded" and can never break chat.
 */

import { createClient } from "@libsql/client";

async function main(): Promise<number> {
  const url = process.env.ANALYTICS_TURSO_URL;
  const token = process.env.ANALYTICS_TURSO_TOKEN;
  if (!url || !token) {
    console.error("[analytics] Set ANALYTICS_TURSO_URL and ANALYTICS_TURSO_TOKEN to read counts.");
    return 1;
  }
  const client = createClient({ url, authToken: token });
  try {
    const rs = await client.execute(
      "SELECT day, event, dimension, count FROM daily_counts " +
        "WHERE day >= date('now', '-30 days') ORDER BY day DESC, event ASC, dimension ASC"
    );
    if (rs.rows.length === 0) {
      console.log("[analytics] No counts in the last 30 days.");
      return 0;
    }
    console.log("day        | event               | dimension              | count");
    console.log("-----------|---------------------|------------------------|-------");
    for (const row of rs.rows) {
      const r = row as unknown as Record<string, unknown>;
      const line =
        `${String(r.day ?? "").padEnd(10)} | ` +
        `${String(r.event ?? "").padEnd(19)} | ` +
        `${String(r.dimension ?? "").padEnd(22)} | ` +
        `${String(r.count ?? "")}`;
      console.log(line);
    }
    return 0;
  } catch (error) {
    console.error("[analytics] Query failed:", error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    client.close();
  }
}

const isMain =
  typeof process.argv[1] === "string" && process.argv[1].endsWith("analytics.ts");

if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("[analytics] Uncaught error:", err);
      process.exit(1);
    });
}

export { main as runAnalytics };
