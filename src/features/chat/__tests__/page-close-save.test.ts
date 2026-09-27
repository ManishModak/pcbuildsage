import { describe, expect, it, vi } from "vitest";
import type { SaveSessionRequest } from "@/lib/api-client";
import type { ChatUIMessage } from "../message";
import {
  decideStreamPersist,
  registerPageCloseFlush,
  sessionSignature,
  shouldFlushOnPageHide,
  SessionSaveQueue,
  STREAM_PERSIST_INTERVAL_MS,
  type PageLifecycleEvents
} from "../session-save-queue";

/** A minimal `document`/`window` stand-in that records what was registered. */
function fakeLifecycle(visibilityState = "visible") {
  const listeners = new Map<string, Set<() => void>>();
  const events: PageLifecycleEvents = {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      const set = listeners.get(type);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) listeners.delete(type);
    }
  };
  return {
    events,
    registered: () => [...listeners.keys()],
    fire(type: string) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    setVisibilityState(next: string) {
      visibilityState = next;
    }
  };
}

function userMessage(text: string): ChatUIMessage {
  return { id: `m-${text}`, role: "user", parts: [{ type: "text", text }] } as ChatUIMessage;
}

function partialReply(): ChatUIMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "text", text: "Start with an AM5 board" }]
  } as ChatUIMessage;
}

function snapshot(messages: ChatUIMessage[]): Omit<SaveSessionRequest, "revision"> {
  return { id: "session-1", messages, title: "Partial" };
}

describe("decideStreamPersist", () => {
  const base = { streaming: true, lastSavedSignature: "a", lastSavedAt: 1_000, now: 1_000 };

  it("skips entirely when nothing is streaming", () => {
    expect(decideStreamPersist({ ...base, streaming: false, signature: "b" })).toBe("skip");
  });

  it("skips an unchanged transcript", () => {
    expect(decideStreamPersist({ ...base, signature: "a" })).toBe("skip");
  });

  it("saves the first update of a stream immediately", () => {
    expect(
      decideStreamPersist({ ...base, signature: "b", lastSavedAt: null, lastSavedSignature: null })
    ).toBe("save");
  });

  it("throttles the next update inside the interval", () => {
    const now = 1_000 + STREAM_PERSIST_INTERVAL_MS - 1;
    expect(decideStreamPersist({ ...base, signature: "b", now })).toBe("throttle");
  });

  it("saves once the interval has elapsed", () => {
    const now = 1_000 + STREAM_PERSIST_INTERVAL_MS;
    expect(decideStreamPersist({ ...base, signature: "b", now })).toBe("save");
  });
});

describe("registerPageCloseFlush", () => {
  it("flushes on visibilitychange when the page becomes hidden", () => {
    const lifecycle = fakeLifecycle();
    const flush = vi.fn();
    registerPageCloseFlush(lifecycle.events, flush);

    lifecycle.setVisibilityState("hidden");
    lifecycle.fire("visibilitychange");

    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("does not flush on visibilitychange while the page is still visible", () => {
    const lifecycle = fakeLifecycle("visible");
    const flush = vi.fn();
    registerPageCloseFlush(lifecycle.events, flush);

    lifecycle.fire("visibilitychange");

    expect(flush).not.toHaveBeenCalled();
  });

  it("flushes on pagehide", () => {
    const lifecycle = fakeLifecycle();
    const flush = vi.fn();
    registerPageCloseFlush(lifecycle.events, flush);

    lifecycle.fire("pagehide");

    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("does not use beforeunload or unload, which are not reliably fired", () => {
    const lifecycle = fakeLifecycle();
    const flush = vi.fn();
    registerPageCloseFlush(lifecycle.events, flush);

    expect(lifecycle.registered().sort()).toEqual(["pagehide", "visibilitychange"]);

    lifecycle.fire("beforeunload");
    lifecycle.fire("unload");
    expect(flush).not.toHaveBeenCalled();
  });

  it("unregisters both listeners", () => {
    const lifecycle = fakeLifecycle();
    const flush = vi.fn();
    const unregister = registerPageCloseFlush(lifecycle.events, flush);
    unregister();

    lifecycle.setVisibilityState("hidden");
    lifecycle.fire("visibilitychange");
    lifecycle.fire("pagehide");

    expect(flush).not.toHaveBeenCalled();
    expect(lifecycle.registered()).toEqual([]);
  });
});

describe("closing mid-stream", () => {
  it("keeps the partial reply: the page-close flush persists the messages so far", async () => {
    const persisted: (SaveSessionRequest & { urgent?: boolean })[] = [];
    const persist = vi.fn(async (request: SaveSessionRequest, options?: { urgent?: boolean }) => {
      persisted.push({ ...request, urgent: options?.urgent });
    });
    const queue = new SessionSaveQueue(persist, sessionSignature([]), 0, () => {}, {
      sleep: () => Promise.resolve()
    });

    const messages = [userMessage("build me a 1440p gaming PC"), partialReply()];
    const lifecycle = fakeLifecycle();
    registerPageCloseFlush(lifecycle.events, () => {
      // What `chat-view.tsx` does: enqueue the current transcript as urgent.
      void queue.enqueue(sessionSignature(messages), snapshot(messages), { urgent: true });
    });

    lifecycle.setVisibilityState("hidden");
    lifecycle.fire("visibilitychange");
    await Promise.resolve();
    await Promise.resolve();

    expect(persisted).toHaveLength(1);
    expect(persisted[0].urgent).toBe(true);
    expect(persisted[0].messages).toHaveLength(2);
    expect(JSON.stringify(persisted[0].messages)).toContain("Start with an AM5 board");
  });

  it("flushes on pagehide as well, even mid-stream", async () => {
    const persisted: SaveSessionRequest[] = [];
    const persist = vi.fn(async (request: SaveSessionRequest) => {
      persisted.push(request);
    });
    const queue = new SessionSaveQueue(persist, sessionSignature([]), 0, () => {}, {
      sleep: () => Promise.resolve()
    });

    const messages = [userMessage("hi"), partialReply()];
    const lifecycle = fakeLifecycle();
    registerPageCloseFlush(lifecycle.events, () => {
      void queue.enqueue(sessionSignature(messages), snapshot(messages), { urgent: true });
    });

    lifecycle.fire("pagehide");
    await Promise.resolve();
    await Promise.resolve();

    expect(persisted).toHaveLength(1);
    expect(JSON.stringify(persisted[0].messages)).toContain("Start with an AM5 board");
  });

  it("a throttle cycle writes intermediate replies, not just the final one", () => {    const decisions: string[] = [];
    let lastSavedAt: number | null = null;
    let lastSavedSignature: string | null = null;
    let now = 0;

    // Three transcript updates during one stream, 1s apart.
    for (const signature of ["t1", "t2", "t3", "t4", "t5", "t6"]) {
      now += 1_000;
      const decision = decideStreamPersist({
        streaming: true,
        signature,
        lastSavedSignature,
        lastSavedAt,
        now
      });
      if (decision === "save") {
        decisions.push(signature);
        lastSavedSignature = signature;
        lastSavedAt = now;
      }
    }

    expect(decisions).toEqual(["t1", "t6"]);
  });
});

describe("shouldFlushOnPageHide", () => {
  const acknowledged = new Set(["stored"]);

  it("skips an idle chat whose transcript is already stored", () => {
    // The tab-switch case: re-uploading an unchanged transcript is pure waste,
    // and on a long chat it is hundreds of kilobytes per switch.
    expect(
      shouldFlushOnPageHide({
        messageCount: 2,
        streaming: false,
        signature: "stored",
        isAcknowledged: (signature) => acknowledged.has(signature)
      })
    ).toBe(false);
  });

  it("flushes while a reply is streaming, even if the last save matched", () => {
    expect(
      shouldFlushOnPageHide({
        messageCount: 2,
        streaming: true,
        signature: "stored",
        isAcknowledged: (signature) => acknowledged.has(signature)
      })
    ).toBe(true);
  });

  it("flushes when the transcript has changed since the last save", () => {
    expect(
      shouldFlushOnPageHide({
        messageCount: 3,
        streaming: false,
        signature: "newer",
        isAcknowledged: (signature) => acknowledged.has(signature)
      })
    ).toBe(true);
  });

  it("flushes when the last save failed, so the queue never acknowledged it", () => {
    // `isAcknowledged` is false precisely because the save did not land: this is
    // the last chance to get the transcript out.
    expect(
      shouldFlushOnPageHide({
        messageCount: 3,
        streaming: false,
        signature: "never-stored",
        isAcknowledged: () => false
      })
    ).toBe(true);
  });

  it("never flushes an empty chat", () => {
    expect(
      shouldFlushOnPageHide({
        messageCount: 0,
        streaming: true,
        signature: "stored",
        isAcknowledged: () => true
      })
    ).toBe(false);
  });
});

describe("repeated tab switches", () => {
  it("does not re-upload an unchanged transcript", async () => {
    const uploads: string[] = [];
    const persist = vi.fn(async (request: SaveSessionRequest) => {
      uploads.push(JSON.stringify(request.messages));
    });
    const queue = new SessionSaveQueue(persist, sessionSignature([]), 0, () => {}, {
      sleep: () => Promise.resolve()
    });
    const messages = [userMessage("a settled conversation")];

    const lifecycle = fakeLifecycle();
    registerPageCloseFlush(lifecycle.events, () => {
      const current = messages;
      const shouldFlush = shouldFlushOnPageHide({
        messageCount: current.length,
        streaming: false,
        signature: sessionSignature(current),
        isAcknowledged: (signature) => queue.isAcknowledged(signature)
      });
      if (!shouldFlush) return;
      void queue.enqueue(sessionSignature(current), snapshot(current), { urgent: true });
    });

    // The ordinary save happens first, as it would after a finished turn.
    await queue.enqueue(sessionSignature(messages), snapshot(messages));
    expect(uploads).toHaveLength(1);

    // Five tab switches, nothing changed in between.
    for (let i = 0; i < 5; i++) {
      lifecycle.setVisibilityState("hidden");
      lifecycle.fire("visibilitychange");
      lifecycle.setVisibilityState("visible");
      await Promise.resolve();
    }

    expect(uploads).toHaveLength(1);
  });
});
