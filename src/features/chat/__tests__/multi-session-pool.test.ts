import { describe, expect, it } from "vitest";
import type { ChatUIMessage } from "../message";
import {
  applySessionSelection,
  chooseEvictionIndex,
  decideOpenAction,
  invalidateSessionSelection,
  MAX_ACTIVE_SESSIONS,
  shouldRefetchOnOpen,
  type PoolEntry
} from "../session-selection";
import { SessionSaveQueue, sessionSignature } from "../session-save-queue";

type ActiveSessionEntry = PoolEntry<SessionSaveQueue>;

const noSleep = () => Promise.resolve();

function makeQueue() {
  return new SessionSaveQueue(async () => {}, sessionSignature([]), 0, () => {}, { sleep: noSleep });
}

function userMessage(text: string): ChatUIMessage {
  return { id: `m-${text}`, role: "user", parts: [{ type: "text", text }] } as ChatUIMessage;
}

function entry(id: string, lastActiveAt: number, overrides: Partial<ActiveSessionEntry> = {}): ActiveSessionEntry {
  return { id, messages: [], queue: makeQueue(), lastActiveAt, ...overrides };
}

function poolOf(count: number, streamingIds: string[] = []): ActiveSessionEntry[] {
  const pool: ActiveSessionEntry[] = [];
  for (let i = 1; i <= count; i++) {
    const id = `session-${i}`;
    pool.push(entry(id, i * 100, { isStreaming: streamingIds.includes(id) }));
  }
  return pool;
}

describe("Option A - Multi-Session Background Tab Pool", () => {
  it("keeps existing session in pool without recreating queue or messages", () => {
    const queue = makeQueue();
    const initial = entry("session-1", 1000, { messages: [userMessage("hello")] });

    const { pool, currentId } = applySessionSelection({
      pool: [initial],
      currentSessionId: "session-1",
      id: "session-1",
      loaded: true,
      messages: [],
      newEntry: { id: "session-1", queue, isStreaming: false, lastActiveAt: 0 }
    });

    expect(pool).toHaveLength(1);
    expect(pool[0].id).toBe("session-1");
    expect(pool[0].messages).toHaveLength(1);
    expect(pool[0].lastActiveAt).toBeGreaterThanOrEqual(1000);
    expect(currentId).toBe("session-1");
  });

  it("evicts the oldest inactive session when pool reaches capacity limit", () => {
    // session-1 has the lowest lastActiveAt (100) and is inactive (session-8 is current)
    const { pool, currentId } = applySessionSelection({
      pool: poolOf(MAX_ACTIVE_SESSIONS),
      currentSessionId: "session-8",
      id: "session-9",
      loaded: true,
      messages: [],
      newEntry: { id: "session-9", queue: makeQueue(), isStreaming: false, lastActiveAt: 900 }
    });

    expect(pool).toHaveLength(MAX_ACTIVE_SESSIONS);
    expect(pool.map((s) => s.id)).not.toContain("session-1");
    expect(pool.map((s) => s.id)).toContain("session-9");
    expect(currentId).toBe("session-9");
  });

  it("never evicts the currently active session even if it was created earlier", () => {
    // session-1 is currently active despite having lowest timestamp (100)
    const { pool, currentId } = applySessionSelection({
      pool: poolOf(MAX_ACTIVE_SESSIONS),
      currentSessionId: "session-1",
      id: "session-9",
      loaded: true,
      messages: [],
      newEntry: { id: "session-9", queue: makeQueue(), isStreaming: false, lastActiveAt: 1000 }
    });

    expect(pool).toHaveLength(MAX_ACTIVE_SESSIONS);
    expect(pool.map((s) => s.id)).toContain("session-1");
    expect(pool.map((s) => s.id)).not.toContain("session-2"); // session-2 was evicted
    expect(pool.map((s) => s.id)).toContain("session-9");
    expect(currentId).toBe("session-9");
  });

  it("does not evict a streaming session: opening a 9th chat never cuts off a reply", () => {
    // Every background tab but one is mid-stream; session-2 is the only idle one.
    const pool = poolOf(MAX_ACTIVE_SESSIONS, [
      "session-1",
      "session-3",
      "session-4",
      "session-5",
      "session-6",
      "session-7"
    ]);

    const { pool: next, currentId } = applySessionSelection({
      pool,
      currentSessionId: "session-8",
      id: "session-9",
      loaded: true,
      messages: [],
      newEntry: { id: "session-9", queue: makeQueue(), isStreaming: false, lastActiveAt: 900 }
    });

    expect(next.map((s) => s.id)).toContain("session-1");
    expect(next.map((s) => s.id)).toContain("session-3");
    // session-2 is idle and the least recently active, so it is the one to drop.
    expect(next.map((s) => s.id)).not.toContain("session-2");
    expect(next).toHaveLength(MAX_ACTIVE_SESSIONS);
    expect(currentId).toBe("session-9");
  });

  it("exceeds the cap rather than evicting a streaming session", () => {
    const pool = poolOf(MAX_ACTIVE_SESSIONS, [
      "session-1",
      "session-2",
      "session-3",
      "session-4",
      "session-5",
      "session-6",
      "session-7"
    ]);

    expect(chooseEvictionIndex(pool, "session-8")).toBe(-1);

    const { pool: next, currentId } = applySessionSelection({
      pool,
      currentSessionId: "session-8",
      id: "session-9",
      loaded: true,
      messages: [],
      newEntry: { id: "session-9", queue: makeQueue(), isStreaming: false, lastActiveAt: 900 }
    });

    // Only the current tab is idle, and it must never be evicted either.
    expect(next).toHaveLength(MAX_ACTIVE_SESSIONS + 1);
    expect(next.map((s) => s.id)).toContain("session-8");
    expect(currentId).toBe("session-9");
  });

  it("clears the previous chat and flags the new one loading in the same update", () => {
    const pool = [entry("session-a", 100, { messages: [userMessage("secret chat A content")] })];

    const { pool: next, currentId } = applySessionSelection({
      pool,
      currentSessionId: "session-a",
      id: "session-b",
      loaded: false,
      messages: [],
      newEntry: { id: "session-b", queue: makeQueue(), isStreaming: false, lastActiveAt: 0 }
    });

    const b = next.find((s) => s.id === "session-b");
    expect(b?.isLoading).toBe(true);
    // Nothing from chat A is reachable through the new chat's entry.
    expect(JSON.stringify(b)).not.toContain("secret chat A content");
    expect(currentId).toBe("session-b");
  });

  it("replaces the loading entry with the loaded messages", () => {
    const loading = [entry("session-b", 100, { isLoading: true })];

    const { pool: next } = applySessionSelection({
      pool: loading,
      currentSessionId: "session-b",
      id: "session-b",
      loaded: true,
      messages: [userMessage("real chat B")],
      newEntry: { id: "session-b", queue: makeQueue(), isStreaming: false, lastActiveAt: 0 }
    });

    expect(next[0].isLoading).toBe(false);
    expect(next[0].messages).toHaveLength(1);
  });

  it("leaves a genuinely empty chat when the load fails", () => {
    const loading = [entry("session-b", 100, { isLoading: true })];

    const { pool: next } = applySessionSelection({
      pool: loading,
      currentSessionId: "session-b",
      id: "session-b",
      loaded: false,
      messages: [],
      newEntry: { id: "session-b", queue: makeQueue(), isStreaming: false, lastActiveAt: 0 }
    });

    expect(next[0].isLoading).toBe(false);
    expect(next[0].messages).toEqual([]);
  });

  it("does not blank a streaming background tab when the user clicks back to it", () => {
    const streaming = [entry("session-a", 100, { isStreaming: true, messages: [userMessage("mid-reply")] })];

    const { pool: next, currentId } = applySessionSelection({
      pool: streaming,
      currentSessionId: "session-b",
      id: "session-a",
      loaded: false,
      messages: [],
      newEntry: { id: "session-a", queue: makeQueue(), isStreaming: true, lastActiveAt: 0 }
    });

    expect(next).toHaveLength(1);
    expect(next[0].messages).toHaveLength(1);
    expect(next[0].isStreaming).toBe(true);
    expect(next[0].isLoading).toBe(false);
    expect(currentId).toBe("session-a");
  });
});

describe("re-opening a chat whose load was cancelled", () => {
  it("re-fetches instead of showing the fake new-chat screen", () => {
    const failed = entry("session-a", 100, { isLoading: false });
    expect(shouldRefetchOnOpen(failed)).toBe(true);
    expect(decideOpenAction(failed)).toBe("fetch");
  });

  it("keeps the shortcut for a chat that is still loading", () => {
    expect(shouldRefetchOnOpen(entry("session-a", 100, { isLoading: true }))).toBe(false);
  });

  it("keeps the shortcut for a chat with messages, which is what preserves its stream", () => {
    const open = entry("session-a", 100, { messages: [userMessage("real content")] });
    expect(shouldRefetchOnOpen(open)).toBe(false);
    expect(decideOpenAction(open)).toBe("switch");
  });

  it("keeps the shortcut for a streaming chat with no messages yet", () => {
    const streaming = entry("session-a", 100, { isStreaming: true });
    expect(shouldRefetchOnOpen(streaming)).toBe(false);
  });

  it("fetches a chat that is not in the pool at all", () => {
    expect(decideOpenAction(undefined)).toBe("fetch");
  });

  it("marks a re-fetched empty entry as loading, not as an empty chat", () => {
    const failed = [entry("session-a", 100, { isLoading: false })];
    const { pool: refetching } = applySessionSelection({
      pool: failed,
      currentSessionId: "session-b",
      id: "session-a",
      loaded: false,
      messages: [],
      pendingLoad: true,
      newEntry: { id: "session-a", queue: makeQueue(), isStreaming: false, lastActiveAt: 0 }
    });

    expect(refetching[0].isLoading).toBe(true);
  });

  it("the whole click-away-then-back sequence ends with a second fetch", async () => {
    // Reproduces the reported sequence: click A, switch to B mid-fetch, click A again.
    const guard = { generation: 0 };
    let pool: PoolEntry<SessionSaveQueue>[] = [
      entry("session-b", 100, { messages: [userMessage("chat B")], isStreaming: false })
    ];
    let currentId = "session-b";
    const fetches: string[] = [];

    async function click(id: string) {
      const existing = pool.find((e) => e.id === id);
      if (decideOpenAction(existing) === "switch") {
        invalidateSessionSelection(guard);
        currentId = id;
        return { fetched: false, refetching: false };
      }
      const refetching = existing !== undefined;
      fetches.push(id);
      pool = applySessionSelection({
        pool,
        currentSessionId: currentId,
        id,
        loaded: false,
        messages: [],
        pendingLoad: refetching,
        newEntry: { id, queue: makeQueue(), isStreaming: false, lastActiveAt: 0 }
      }).pool;
      currentId = id;
      return { fetched: true, refetching };
    }

    // 1. Click A, which is not open: a fetch starts and is still in flight.
    const firstClick = await click("session-a");
    expect(firstClick.fetched).toBe(true);
    expect(fetches).toEqual(["session-a"]);
    expect(pool.find((e) => e.id === "session-a")?.isLoading).toBe(true);

    // 2. Click B, which is open. This cancels A's fetch, so A's load path fails and
    //    clears the spinner - leaving an empty, idle entry.
    invalidateSessionSelection(guard);
    pool = pool.map((e) => (e.id === "session-a" ? { ...e, isLoading: false } : e));
    currentId = "session-b";
    expect(pool.find((e) => e.id === "session-a")).toMatchObject({ isLoading: false, messages: [] });

    // 3. Click A again. It is in the pool, but empty and idle, so it must be re-fetched.
    const secondClick = await click("session-a");
    expect(secondClick.fetched).toBe(true);
    expect(secondClick.refetching).toBe(true);
    expect(fetches).toEqual(["session-a", "session-a"]);
    // And the user sees a loading state, not the new-chat screen.
    expect(pool.find((e) => e.id === "session-a")?.isLoading).toBe(true);
  });
});
