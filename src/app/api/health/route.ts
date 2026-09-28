import { getDeploymentMode } from "@/lib/config/deployment";
import type { CatalogRepository } from "@/lib/catalog";
import { json } from "../_lib/responses";

export const runtime = "nodejs";

/** Upper bound for the hosted catalog ping; Render's health check must never hang on Turso. */
const CATALOG_PING_TIMEOUT_MS = 2_000;

// One repository (and so one libsql client) per process, created on first
// successful resolve. A failed resolve (e.g. missing TURSO_DATABASE_URL) is
// not cached, so the next check retries.
let cachedRepo: CatalogRepository | null = null;

type SqlClientLike = { execute: (sql: string) => Promise<unknown> };

async function pingCatalog(): Promise<void> {
  if (!cachedRepo) {
    const { getCatalogRepository } = await import("@/lib/catalog");
    cachedRepo = getCatalogRepository("hosted-demo");
  }
  const client = (cachedRepo as { client?: Partial<SqlClientLike> }).client;
  if (typeof client?.execute !== "function") {
    throw new Error("Catalog repository has no SQL client to ping.");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Catalog ping timed out.")), CATALOG_PING_TIMEOUT_MS);
  });
  try {
    // Trivial indexed probe: proves the DB is reachable and the table exists
    // without scanning it.
    await Promise.race([client.execute("SELECT 1 FROM products LIMIT 1"), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Liveness endpoint used by Render's health check. Always HTTP 200 so a slow
 * or unreachable Turso never causes a restart loop; hosted mode reports
 * status "degraded" with catalog.reachable:false when the ping fails.
 */
export async function GET(): Promise<Response> {
  const mode = getDeploymentMode();
  const timestamp = new Date().toISOString();

  if (mode === "hosted-demo") {
    let reachable = true;
    try {
      await pingCatalog();
    } catch {
      reachable = false;
    }
    return json({
      status: reachable ? "ok" : "degraded",
      mode,
      timestamp,
      catalog: { reachable }
    });
  }

  return json({
    status: "ok",
    mode,
    timestamp
  });
}
