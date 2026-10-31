import { describe, expect, it } from "vitest";
import type { SessionDetail } from "@/lib/api-client";
import {
  invalidateSessionSelection,
  MAX_ACTIVE_SESSIONS,
  selectLatestSession,
  shrinkSessionPool,
  type PoolEntry
} from "../session-selection";

function session(id: string): SessionDetail {
  return {
    id,
    revision: 0,
    title: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    country_code: null,
    currency: null,
    messages: [],
    build_state: null
  };
}

describe("selectLatestSession", () => {
  it("lets fast B win when delayed A finishes last", async () => {
    const resolvers = new Map<string, (value: SessionDetail) => void>();
    const load = (id: string) => new Promise<SessionDetail>((resolve) => resolvers.set(id, resolve));
    const committed: string[] = [];
    const guard = { generation: 0 };

    const loadA = selectLatestSession(guard, "a", load, (value) => committed.push(value.id));
    const loadB = selectLatestSession(guard, "b", load, (value) => committed.push(value.id));
    resolvers.get("b")!(session("b"));
    await loadB;
    resolvers.get("a")!(session("a"));
    await loadA;

    expect(committed).toEqual(["b"]);
  });

  it("does not commit a failed or missing load", async () => {
    const committed: string[] = [];
    const guard = { generation: 0 };

    await selectLatestSession(guard, "failed", async () => { throw new Error("offline"); }, (value) => committed.push(value.id));
    await selectLatestSession(guard, "missing", async () => null, (value) => committed.push(value.id));

    expect(committed).toEqual([]);
  });

  it("does not commit a load invalidated by a newer action", async () => {
    let resolve!: (value: SessionDetail) => void;
    const load = new Promise<SessionDetail>((done) => { resolve = done; });
    const committed: string[] = [];
    const guard = { generation: 0 };

    const pending = selectLatestSession(guard, "a", async () => load, (value) => committed.push(value.id));
    invalidateSessionSelection(guard);
    resolve(session("a"));
    await pending;

    expect(committed).toEqual([]);
  });
});

describe("shrinkSessionPool", () => {
  function entry(id: string, overrides: Partial<PoolEntry<unknown>> = {}): PoolEntry<unknown> {
    return {
      id,
      messages: [],
      lastActiveAt: 0,
      queue: null,
      ...overrides
    };
  }

  it("leaves a pool at the cap alone", () => {
    const pool = Array.from({ length: MAX_ACTIVE_SESSIONS }, (_, i) =>
      entry(`s${i}`, { lastActiveAt: i })
    );
    const { pool: next, evictedIds } = shrinkSessionPool({ pool, currentSessionId: "s0" });

    expect(next.map((e) => e.id)).toEqual(pool.map((e) => e.id));
    expect(evictedIds).toEqual([]);
  });

  it("evicts the oldest idle entry until the pool is back at the cap", () => {
    const pool = [
      entry("current", { lastActiveAt: 0 }),
      entry("old-idle", { lastActiveAt: 1 }),
      entry("new-idle", { lastActiveAt: 9 }),
      ...Array.from({ length: MAX_ACTIVE_SESSIONS - 1 }, (_, i) =>
        entry(`extra${i}`, { lastActiveAt: 5 })
      )
    ];
    const { pool: next, evictedIds } = shrinkSessionPool({ pool, currentSessionId: "current" });

    expect(next).toHaveLength(MAX_ACTIVE_SESSIONS);
    expect(evictedIds).toContain("old-idle");
    expect(next.map((e) => e.id)).toContain("current");
    expect(next.map((e) => e.id)).toContain("new-idle");
  });

  it("never evicts the active chat or a streaming chat, even over the cap", () => {
    const pool = [
      entry("current", { lastActiveAt: 0 }),
      entry("streaming", { lastActiveAt: 1, isStreaming: true }),
      ...Array.from({ length: MAX_ACTIVE_SESSIONS }, (_, i) =>
        entry(`idle${i}`, { lastActiveAt: 5 + i })
      )
    ];
    const { pool: next, evictedIds } = shrinkSessionPool({ pool, currentSessionId: "current" });

    expect(next.map((e) => e.id)).toContain("current");
    expect(next.map((e) => e.id)).toContain("streaming");
    expect(evictedIds).not.toContain("current");
    expect(evictedIds).not.toContain("streaming");
    expect(next).toHaveLength(MAX_ACTIVE_SESSIONS);
  });

  it("keeps everything when only the active chat and streams are left", () => {
    const pool = [
      entry("current", { lastActiveAt: 0 }),
      ...Array.from({ length: MAX_ACTIVE_SESSIONS }, (_, i) =>
        entry(`stream${i}`, { lastActiveAt: i + 1, isStreaming: true })
      )
    ];
    const { pool: next, evictedIds } = shrinkSessionPool({ pool, currentSessionId: "current" });

    expect(next).toHaveLength(pool.length);
    expect(evictedIds).toEqual([]);
  });
});
