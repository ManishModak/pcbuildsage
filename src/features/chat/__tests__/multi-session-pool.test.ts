import { describe, expect, it } from "vitest";
import type { ChatUIMessage } from "../message";
import { SessionSaveQueue, sessionSignature } from "../session-save-queue";

interface ActiveSessionEntry {
  id: string;
  messages: ChatUIMessage[];
  queue: SessionSaveQueue;
  lastActiveAt: number;
}

const MAX_ACTIVE_SESSIONS = 8;

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
    let oldestIndex = -1;
    let oldestTime = Infinity;
    for (let i = 0; i < nextList.length; i++) {
      const item = nextList[i];
      if (item.id !== currentActiveId && item.lastActiveAt < oldestTime) {
        oldestTime = item.lastActiveAt;
        oldestIndex = i;
      }
    }
    if (oldestIndex !== -1) {
      nextList = nextList.filter((_, i) => i !== oldestIndex);
    }
  }

  return {
    nextPool: [...nextList, { ...newSession, lastActiveAt: timestamp }],
    nextActiveId: newSession.id
  };
}

describe("Option A - Multi-Session Background Tab Pool", () => {
  it("keeps existing session in pool without recreating queue or messages", () => {
    const queue = new SessionSaveQueue(async () => {}, sessionSignature([]));
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
    const pool: ActiveSessionEntry[] = [];
    for (let i = 1; i <= 8; i++) {
      const queue = new SessionSaveQueue(async () => {}, sessionSignature([]));
      pool.push({
        id: `session-${i}`,
        messages: [],
        queue,
        lastActiveAt: i * 100
      });
    }

    // session-1 has the lowest lastActiveAt (100) and is inactive (session-8 is current)
    const newQueue = new SessionSaveQueue(async () => {}, sessionSignature([]));
    const { nextPool, nextActiveId } = updateSessionPool(
      pool,
      "session-8",
      { id: "session-9", messages: [], queue: newQueue },
      900
    );

    expect(nextPool).toHaveLength(8);
    expect(nextPool.map((s) => s.id)).not.toContain("session-1");
    expect(nextPool.map((s) => s.id)).toContain("session-9");
    expect(nextActiveId).toBe("session-9");
  });

  it("never evicts the currently active session even if it was created earlier", () => {
    const pool: ActiveSessionEntry[] = [];
    for (let i = 1; i <= 8; i++) {
      const queue = new SessionSaveQueue(async () => {}, sessionSignature([]));
      pool.push({
        id: `session-${i}`,
        messages: [],
        queue,
        lastActiveAt: i * 100
      });
    }

    // session-1 is currently active despite having lowest timestamp (100)
    const newQueue = new SessionSaveQueue(async () => {}, sessionSignature([]));
    const { nextPool, nextActiveId } = updateSessionPool(
      pool,
      "session-1",
      { id: "session-9", messages: [], queue: newQueue },
      1000
    );

    expect(nextPool).toHaveLength(8);
    expect(nextPool.map((s) => s.id)).toContain("session-1");
    expect(nextPool.map((s) => s.id)).not.toContain("session-2"); // session-2 was evicted
    expect(nextPool.map((s) => s.id)).toContain("session-9");
    expect(nextActiveId).toBe("session-9");
  });
});
