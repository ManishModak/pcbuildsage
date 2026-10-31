/**
 * src/lib/mcp/session-store.ts
 *
 * Eviction policy for the in-memory MCP sessions in src/app/api/mcp/route.ts.
 * The v2 SDK offers no built-in session cap (its docs show a hand-rolled map),
 * so this module keeps that policy unit-testable: drop sessions idle longer
 * than MCP_SESSION_IDLE_MS, then trim to MCP_MAX_SESSIONS oldest-first,
 * closing every evicted transport. Closing is what ends the session's SSE
 * streams and rejects its pending requests.
 */

export const MCP_SESSION_IDLE_MS = 30 * 60_000;
export const MCP_MAX_SESSIONS = 100;

export interface EvictableTransport {
  close(): Promise<unknown> | unknown;
}

export interface SessionEntry<T extends EvictableTransport = EvictableTransport> {
  transport: T;
  lastActive: number;
}

export interface EvictionOptions {
  idleMs?: number;
  maxSessions?: number;
  now?: number;
}

/** Removes idle and over-cap sessions (oldest first), closing their transports. Returns evicted IDs. */
export async function evictSessions<T extends EvictableTransport>(
  sessions: Map<string, SessionEntry<T>>,
  options?: EvictionOptions
): Promise<string[]> {
  const idleMs = options?.idleMs ?? MCP_SESSION_IDLE_MS;
  const maxSessions = options?.maxSessions ?? MCP_MAX_SESSIONS;
  const now = options?.now ?? Date.now();
  const evicted: string[] = [];

  async function evict(id: string): Promise<void> {
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    evicted.push(id);
    await entry.transport.close();
  }

  for (const [id, entry] of [...sessions]) {
    if (now - entry.lastActive >= idleMs) await evict(id);
  }

  const byAge = [...sessions.entries()].sort((a, b) => a[1].lastActive - b[1].lastActive);
  let over = sessions.size - maxSessions;
  for (const [id] of byAge) {
    if (over <= 0) break;
    await evict(id);
    over--;
  }

  return evicted;
}
