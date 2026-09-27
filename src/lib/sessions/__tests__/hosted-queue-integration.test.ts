import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getClientSession,
  resetClientStoreState,
  saveClientSession,
  _setStorageDriverForTesting
} from "@/lib/sessions/client-store";
import { SessionSaveQueue, sessionSignature } from "@/features/chat/session-save-queue";
import type { ChatUIMessage } from "@/features/chat/message";

/**
 * The hosted store rejects an older revision and refuses to recreate a deleted
 * session. Those rules have to be compatible with the queue's habit of claiming
 * a fresh revision on every attempt, otherwise a normal save flow deadlocks
 * against its own protection. These tests drive the real queue into the real
 * store, so the two cannot drift apart.
 */

function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear()
  };
}

function userMessage(text: string): ChatUIMessage {
  return { id: `m-${text}`, role: "user", parts: [{ type: "text", text }] } as ChatUIMessage;
}

function snapshot(messages: ChatUIMessage[]) {
  return { id: "session-hosted", messages, title: messages.at(-1) ? "Hosted" : "New" };
}

/** The real queue -> real store path, with an injectable sleep. */
function createQueue(revision = 0) {
  const persist = vi.fn(saveClientSession);
  const queue = new SessionSaveQueue(persist, sessionSignature([]), revision, () => {}, {
    sleep: () => Promise.resolve()
  });
  return { queue, persist };
}

describe("hosted store driven by the real save queue", () => {
  beforeEach(() => {
    resetClientStoreState();
    vi.stubGlobal("indexedDB", undefined);
    vi.stubGlobal("localStorage", createMemoryStorage());
    _setStorageDriverForTesting("localstorage");
  });

  afterEach(() => {
    resetClientStoreState();
    vi.unstubAllGlobals();
  });

  it("saves a normal sequence of turns end to end", async () => {
    const { queue } = createQueue();

    await queue.enqueue(sessionSignature([userMessage("a")]), snapshot([userMessage("a")]));
    await queue.enqueue(sessionSignature([userMessage("a"), userMessage("b")]), snapshot([userMessage("a"), userMessage("b")]));
    await queue.enqueue(
      sessionSignature([userMessage("a"), userMessage("b"), userMessage("c")]),
      snapshot([userMessage("a"), userMessage("b"), userMessage("c")])
    );

    const stored = await getClientSession("session-hosted");
    expect(stored?.messages).toHaveLength(3);
    expect(stored?.revision).toBe(3);
  });

  it("a retried save still lands, because the retry claims a newer revision", async () => {
    const { queue, persist } = createQueue();
    const messages = [userMessage("flaky turn")];

    // The first attempt reaches the store but its result never arrives - the exact
    // case where reusing the same revision would be rejected as stale.
    persist.mockImplementationOnce(async (request) => {
      await saveClientSession(request);
      throw new Error("connection reset after the write");
    });

    await queue.enqueue(sessionSignature(messages), snapshot(messages));

    const stored = await getClientSession("session-hosted");
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls.map(([request]) => request.revision)).toEqual([1, 2]);
    expect(stored?.messages).toHaveLength(1);
  });

  it("a same-content enqueue after a failure still lands", async () => {
    const { queue, persist } = createQueue();
    const messages = [userMessage("retry me")];

    persist.mockRejectedValueOnce(new Error("offline"));

    await queue.enqueue(sessionSignature(messages), snapshot(messages));
    // Unacknowledged, so the same content is written again on the next enqueue.
    await queue.enqueue(sessionSignature(messages), snapshot(messages));

    expect((await getClientSession("session-hosted"))?.messages).toHaveLength(1);
  });

  it("a session loaded at a known revision continues from it", async () => {
    const { queue } = createQueue();
    queue.observeRevision(11);

    await queue.enqueue(sessionSignature([userMessage("after load")]), snapshot([userMessage("after load")]));

    expect((await getClientSession("session-hosted"))?.revision).toBe(12);
  });

  it("an urgent page-close flush lands through the same path", async () => {
    const { queue } = createQueue();
    const partial = [userMessage("mid-stream"), { id: "a1", role: "assistant", parts: [{ type: "text", text: "partial" }] } as ChatUIMessage];

    await queue.enqueue(sessionSignature(partial), snapshot(partial), { urgent: true });

    const stored = await getClientSession("session-hosted");
    expect(stored?.messages).toHaveLength(2);
    expect(JSON.stringify(stored?.messages)).toContain("partial");
  });
});

describe("compacted context rides along on queue-driven saves", () => {
  beforeEach(() => {
    resetClientStoreState();
    vi.stubGlobal("indexedDB", undefined);
    vi.stubGlobal("localStorage", createMemoryStorage());
    _setStorageDriverForTesting("localstorage");
  });

  afterEach(() => {
    resetClientStoreState();
    vi.unstubAllGlobals();
  });

  it("persists compactContext supplied by the snapshot, like chat-view's persistSnapshot does", async () => {
    const compactContext = {
      messages: [{ role: "user" as const, content: "earlier history, summarised" }],
      boundaryMessageId: "m-1"
    };
    const messages = [userMessage("after compaction")];

    // Exactly the queue call chat-view makes: compactContext is just another
    // optional field of the snapshot, so `Omit<SaveSessionRequest, "revision">`
    // carries it without the queue knowing anything about compaction.
    const queue = new SessionSaveQueue(saveClientSession, sessionSignature([]), 0, () => {}, {
      sleep: () => Promise.resolve()
    });
    await queue.enqueue(sessionSignature(messages), { ...snapshot(messages), compactContext });

    const stored = await getClientSession("session-hosted");
    expect(stored?.compact_context?.messages).toHaveLength(1);
    expect(stored?.compact_context?.boundaryMessageId).toBe("m-1");
  });

  it("keeps the stored compactContext when a later save omits it", async () => {
    const compactContext = { messages: [{ role: "user" as const, content: "summary" }] };
    const queue = new SessionSaveQueue(saveClientSession, sessionSignature([]), 0, () => {}, {
      sleep: () => Promise.resolve()
    });

    await queue.enqueue(sessionSignature([userMessage("a")]), { ...snapshot([userMessage("a")]), compactContext });
    await queue.enqueue(sessionSignature([userMessage("a"), userMessage("b")]), snapshot([userMessage("a"), userMessage("b")]));

    expect((await getClientSession("session-hosted"))?.compact_context?.messages).toHaveLength(1);
  });
});
