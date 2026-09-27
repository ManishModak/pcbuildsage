import { describe, expect, it } from "vitest";
import type { ChatUIMessage } from "../message";
import { chooseEvictionIndex } from "../session-selection";
import { SessionSaveQueue, sessionSignature } from "../session-save-queue";

interface ActiveSessionEntry {
  id: string;
  messages: ChatUIMessage[];
  queue: SessionSaveQueue;
  lastActiveAt: number;
  isStreaming?: boolean;
}

const MAX_ACTIVE_SESSIONS = 8;

const noSleep = () => Promise.resolve();

function makeQueue() {
  return new SessionSaveQueue(async () => {}, sessionSignature([]), 0, () => {}, { sleep: noSleep });
}

/**
 * The pool transition as `chat-workspace.tsx` performs it, delegating the
 * eviction decision to the real `chooseEvictionIndex` so this test cannot drift
 * away from the component.
 */
function updateSessionPool(
  currentPool: ActiveSessionEntry[],
  currentActiveId: string,
  newSession: { id: string; messages: ChatUIMessage[]; queue: SessionSaveQueue },
  timestamp: number
): { nextPool: ActiveSessionEntry[]; nextActiveId: string } {
  const existingIndex = currentPool.findIndex((s) => s.id === newSession.id);
  if (existingIndex !== -1) {
    const updated = [...currentPool];
    updated[existingIndex] = {
      ...updated[existingIndex],
      lastActiveAt: timestamp
    };
    return { nextPool: updated, nextActiveId: newSession.id };
  }

  let nextList = currentPool;
  if (nextList.length >= MAX_ACTIVE_SESSIONS) {
    const oldestIndex = chooseEvictionIndex(nextList, currentActiveId);
    if (oldestIndex !== -1) {
      nextList = nextList.filter((_, i) => i !== oldestIndex);
    }
  }

  return {
    nextPool: [...nextList, { ...newSession, lastActiveAt: timestamp, isStreaming: false }],
    nextActiveId: newSession.id
  };
}

function poolOf(count: number, streamingIds: string[] = []): ActiveSessionEntry[] {
  const pool: ActiveSessionEntry[] = [];
  for (let i = 1; i <= count; i++) {
    const id = `session-${i}`;
    pool.push({
      id,
      messages: [],
      queue: makeQueue(),
      lastActiveAt: i * 100,
      isStreaming: streamingIds.includes(id)
    });
  }
  return pool;
}

describe("Option A - Multi-Session Background Tab Pool", () => {
  it("keeps existing session in pool without recreating queue or messages", () => {
    const queue = makeQueue();
    const initial: ActiveSessionEntry = {
      id: "session-1",
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] }],
      queue,
      lastActiveAt: 1000
    };

    const { nextPool, nextActiveId } = updateSessionPool(
      [initial],
      "session-1",
      { id: "session-1", messages: [], queue },
      2000
    );

    expect(nextPool).toHaveLength(1);
    expect(nextPool[0].id).toBe("session-1");
    expect(nextPool[0].messages).toHaveLength(1);
    expect(nextPool[0].lastActiveAt).toBe(2000);
    expect(nextActiveId).toBe("session-1");
  });

  it("evicts the oldest inactive session when pool reaches capacity limit", () => {
    // session-1 has the lowest lastActiveAt (100) and is inactive (session-8 is current)
    const { nextPool, nextActiveId } = updateSessionPool(
      poolOf(8),
      "session-8",
      { id: "session-9", messages: [], queue: makeQueue() },
      900
    );

    expect(nextPool).toHaveLength(8);
    expect(nextPool.map((s) => s.id)).not.toContain("session-1");
    expect(nextPool.map((s) => s.id)).toContain("session-9");
    expect(nextActiveId).toBe("session-9");
  });

  it("never evicts the currently active session even if it was created earlier", () => {
    // session-1 is currently active despite having lowest timestamp (100)
    const { nextPool, nextActiveId } = updateSessionPool(
      poolOf(8),
      "session-1",
      { id: "session-9", messages: [], queue: makeQueue() },
      1000
    );

    expect(nextPool).toHaveLength(8);
    expect(nextPool.map((s) => s.id)).toContain("session-1");
    expect(nextPool.map((s) => s.id)).not.toContain("session-2"); // session-2 was evicted
    expect(nextPool.map((s) => s.id)).toContain("session-9");
    expect(nextActiveId).toBe("session-9");
  });

  it("does not evict a streaming session: opening a 9th chat never cuts off a reply", () => {
    // Every background tab but one is mid-stream; session-2 is the only idle one.
    const pool = poolOf(8, ["session-1", "session-3", "session-4", "session-5", "session-6", "session-7"]);

    const { nextPool, nextActiveId } = updateSessionPool(
      pool,
      "session-8",
      { id: "session-9", messages: [], queue: makeQueue() },
      900
    );

    expect(nextPool.map((s) => s.id)).toContain("session-1");
    expect(nextPool.map((s) => s.id)).toContain("session-3");
    // session-2 is idle and the least recently active, so it is the one to drop.
    expect(nextPool.map((s) => s.id)).not.toContain("session-2");
    expect(nextPool).toHaveLength(8);
    expect(nextActiveId).toBe("session-9");
  });

  it("exceeds the cap rather than evicting a streaming session", () => {
    const pool = poolOf(8, ["session-1", "session-2", "session-3", "session-4", "session-5", "session-6", "session-7"]);

    const { nextPool, nextActiveId } = updateSessionPool(
      pool,
      "session-8",
      { id: "session-9", messages: [], queue: makeQueue() },
      900
    );

    // Only the current tab is idle, and it must never be evicted either.
    expect(chooseEvictionIndex(pool, "session-8")).toBe(-1);
    expect(nextPool).toHaveLength(9);
    expect(nextPool.map((s) => s.id)).toContain("session-8");
    expect(nextActiveId).toBe("session-9");
  });
});
