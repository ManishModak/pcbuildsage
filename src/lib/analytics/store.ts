/**
 * src/lib/analytics/store.ts
 *
 * Buffered anonymous counters for hosted free tiers. Local mode NEVER counts:
 * record() is a no-op and flush() writes nothing unless the deployment mode
 * is "hosted-demo" (see src/lib/config/deployment.ts).
 *
 * Writes go to a SEPARATE Turso database via ANALYTICS_TURSO_URL /
 * ANALYTICS_TURSO_TOKEN only — never the catalog TURSO_* vars. All failures
 * are swallowed so analytics can never break the chat path.
 */

import { createClient, type Client } from "@libsql/client";
import { getDeploymentMode } from "@/lib/config/deployment";
import {
  ANALYTICS_UPSERT_SQL,
  DAILY_COUNTS_DDL,
  isAnalyticsEvent,
  sanitizeDimension,
  type AnalyticsEvent
} from "./events";

/** Flush at most once per minute; shutdown handlers force one last flush. */
export const ANALYTICS_FLUSH_INTERVAL_MS = 60_000;
/** Bound the in-memory buffer so unconfigured hosts cannot grow it forever. */
const MAX_BUFFERED_KEYS = 5_000;
/** A Turso write slower than this is abandoned (see flush() for what happens to its rows). */
export const ANALYTICS_WRITE_TIMEOUT_MS = 5_000;

type BufferedRow = { day: string; event: string; dimension: string; count: number };

const buffer = new Map<string, BufferedRow>();
let lastFlushAt = 0;
let flushTimer: NodeJS.Timeout | null = null;
let shutdownHandlersInstalled = false;
let clientInstance: Client | null = null;
let clientFactoryForTesting: ((url: string, token: string) => Client) | null = null;
let inFlight: Promise<void> | null = null;

class WriteTimeoutError extends Error {}

export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function bufferKey(day: string, event: string, dimension: string): string {
  return `${day}|${event}|${dimension}`;
}

/**
 * One last non-blocking flush on shutdown. `once` matters for beforeExit:
 * the flush schedules async work, so the event loop empties again and
 * beforeExit re-fires; with a persistent listener and an unreachable DB
 * (rows re-buffered) a non-server process would retry forever.
 */
function installShutdownHandlers(): void {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;
  const shutdown = () => {
    void flush({ force: true }).catch(() => {});
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("beforeExit", shutdown);
}

function ensureFlushScheduled(): void {
  if (flushTimer) return;
  try {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush().catch(() => {});
    }, ANALYTICS_FLUSH_INTERVAL_MS);
    if (typeof flushTimer.unref === "function") flushTimer.unref();
  } catch {
    flushTimer = null;
  }
}

function buildClient(): Client | null {
  const url = process.env.ANALYTICS_TURSO_URL;
  const token = process.env.ANALYTICS_TURSO_TOKEN;
  if (!url || !token) return null;
  try {
    if (clientFactoryForTesting) return clientFactoryForTesting(url, token);
    return createClient({ url, authToken: token });
  } catch {
    return null;
  }
}

/**
 * Count one anonymous event. Total function: never throws, no-op in local
 * mode, ignores events outside the allow-list.
 */
export function record(event: string, dimension: string = ""): void {
  try {
    if (!isAnalyticsEvent(event)) return;
    if (getDeploymentMode() !== "hosted-demo") return;
    const cleanDim = sanitizeDimension(dimension);
    const day = utcDay();
    const key = bufferKey(day, event, cleanDim);
    const existing = buffer.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      if (buffer.size >= MAX_BUFFERED_KEYS) {
        const oldest = buffer.keys().next().value;
        if (oldest === undefined) return;
        buffer.delete(oldest);
      }
      buffer.set(key, { day, event, dimension: cleanDim, count: 1 });
    }
    installShutdownHandlers();
    ensureFlushScheduled();
  } catch {
    // Analytics must never break callers.
  }
}

/** Alias with the name G1/G3 landing + onboarding call sites can share. */
export const recordEvent = record;

/**
 * Flush buffered counts to Turso. Throttled to once per minute unless
 * `force` is set (shutdown path). Never throws; never writes in local mode.
 * Concurrent callers share the one in-flight flush; a forced flush (shutdown)
 * then runs once more for rows recorded after that flush drained the buffer.
 */
export function flush(options: { force?: boolean } = {}): Promise<void> {
  if (inFlight) return options.force ? inFlight.then(() => flush(options)) : inFlight;
  inFlight = flushOnce(options).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Drain-then-write: the snapshot leaves the buffer BEFORE the write, so
 * events recorded meanwhile start fresh counts and no row is ever sent twice.
 * - Write rejected: the batch is one transaction that did not commit, so the
 *   rows go back into the buffer for the next flush.
 * - Write timed out (> ANALYTICS_WRITE_TIMEOUT_MS): its outcome is unknown and
 *   it may still land, so the rows are dropped. Losing one slow minute of
 *   counts is preferred over double counting.
 */
async function flushOnce(options: { force?: boolean }): Promise<void> {
  try {
    const now = Date.now();
    if (!options.force && now - lastFlushAt < ANALYTICS_FLUSH_INTERVAL_MS) return;
    lastFlushAt = now;
    if (buffer.size === 0) return;
    if (getDeploymentMode() !== "hosted-demo") {
      buffer.clear();
      return;
    }
    if (!clientInstance) {
      const built = buildClient();
      if (!built) return;
      clientInstance = built;
    }
    const client = clientInstance;
    const snapshot = [...buffer.values()];
    buffer.clear();
    try {
      await withTimeout(writeRows(client, snapshot), ANALYTICS_WRITE_TIMEOUT_MS);
    } catch (error) {
      if (!(error instanceof WriteTimeoutError)) rebuffer(snapshot);
    }
  } catch {
    // Swallowed: analytics failures must never surface.
  }
}

async function writeRows(client: Client, rows: BufferedRow[]): Promise<void> {
  await client.execute(DAILY_COUNTS_DDL);
  await client.batch(
    rows.map((row) => ({
      sql: ANALYTICS_UPSERT_SQL,
      args: [row.day, row.event, row.dimension, row.count] as Array<string | number>
    }))
  );
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WriteTimeoutError()), ms);
    timer.unref?.();
  });
  // A late rejection from abandoned work must not surface as unhandled.
  work.catch(() => {});
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Put failed rows back, merging with anything recorded since the drain. */
function rebuffer(rows: BufferedRow[]): void {
  for (const row of rows) {
    const key = bufferKey(row.day, row.event, row.dimension);
    const current = buffer.get(key);
    if (current) current.count += row.count;
    else if (buffer.size < MAX_BUFFERED_KEYS) buffer.set(key, { ...row });
  }
}

/** Fire-and-forget flush for request paths; never rejects. */
export function flushInBackground(): void {
  void flush().catch(() => {});
}

// --- Test hooks (not used in production paths) ---

export function resetAnalyticsForTesting(): void {
  buffer.clear();
  lastFlushAt = 0;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  clientInstance = null;
  clientFactoryForTesting = null;
  inFlight = null;
}

export function snapshotBufferForTesting(): BufferedRow[] {
  return [...buffer.values()];
}

export function setAnalyticsClientFactoryForTesting(
  factory: ((url: string, token: string) => Client) | null
): void {
  clientFactoryForTesting = factory;
  clientInstance = null;
}

export type { AnalyticsEvent };
