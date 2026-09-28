import { describe, expect, it, vi } from "vitest";
import { HttpError, type SaveSessionRequest } from "@/lib/api-client";
import { SessionSaveQueue, sessionSignature } from "../session-save-queue";

function snapshot(messageId: string) {
  return {
    id: "session",
    messages: [{ id: messageId, role: "user" as const, parts: [] }]
  };
}

/** Backoff is real time; collapse it so the tests stay fast and deterministic. */
const noSleep = () => Promise.resolve();

function staleRevision(revision: number) {
  return new HttpError("stale", 409, { error: "stale_revision", revision });
}

function userMessage(text: string) {
  return { id: `m-${text}`, role: "user" as const, parts: [{ type: "text" as const, text }] };
}

describe("SessionSaveQueue", () => {
  it("serializes writes and coalesces waiting snapshots to the newest revision", async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const persisted: SaveSessionRequest[] = [];
    const persist = vi.fn(async (request: SaveSessionRequest) => {
      persisted.push(request);
      if (persisted.length === 1) await first;
    });
    const onPersisted = vi.fn();
    const queue = new SessionSaveQueue(persist, "initial", 0, onPersisted, { sleep: noSleep });

    const running = queue.enqueue("a", snapshot("a"));
    void queue.enqueue("b", snapshot("b"));
    void queue.enqueue("c", snapshot("c"));
    releaseFirst();
    await running;

    expect(persisted.map((request) => request.messages[0]?.id)).toEqual(["a", "c"]);
    expect(persisted.map((request) => request.revision)).toEqual([1, 3]);
    expect(onPersisted).toHaveBeenCalledTimes(2);
  });

  it("retries a transient failure without acknowledging the failed attempt", async () => {
    const persist = vi.fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    const onPersisted = vi.fn();
    const queue = new SessionSaveQueue(persist, "initial", 0, onPersisted, { sleep: noSleep });

    await queue.enqueue("same", snapshot("same"));

    expect(persist).toHaveBeenCalledTimes(2);
    expect(onPersisted).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure three times with growing backoff, then reports it", async () => {
    const persist = vi.fn().mockRejectedValue(new Error("server on fire"));
    const onPersisted = vi.fn();
    const onPersistError = vi.fn();
    const delays: number[] = [];
    const queue = new SessionSaveQueue(persist, "initial", 0, onPersisted, {
      onPersistError,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      }
    });

    await queue.enqueue("same", snapshot("same"));

    // One initial attempt plus three retries, spaced 250ms / 1s / 4s.
    expect(persist).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([250, 1000, 4000]);
    expect(onPersisted).not.toHaveBeenCalled();
    expect(onPersistError).toHaveBeenCalledTimes(1);
  });

  it("keeps a signature that exhausted its retries unacknowledged so a later enqueue writes it", async () => {
    const persist = vi.fn()
      .mockRejectedValueOnce(new Error("flaky"))
      .mockRejectedValueOnce(new Error("flaky"))
      .mockRejectedValueOnce(new Error("flaky"))
      .mockRejectedValueOnce(new Error("flaky"))
      .mockResolvedValueOnce(undefined);
    const onPersisted = vi.fn();
    const queue = new SessionSaveQueue(persist, "initial", 0, onPersisted, { sleep: noSleep });

    await queue.enqueue("same", snapshot("same"));
    expect(onPersisted).not.toHaveBeenCalled();

    await queue.enqueue("same", snapshot("same"));
    expect(onPersisted).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(5);
  });

  it("claims a newer revision on every retry, so a retry cannot be rejected as stale", async () => {
    const attempts: number[] = [];
    const persist = vi.fn(async (request: SaveSessionRequest) => {
      attempts.push(request.revision);
      if (attempts.length === 1) throw new Error("connection reset after the write");
    });
    const onPersisted = vi.fn();
    const queue = new SessionSaveQueue(persist, "initial", 0, onPersisted, { sleep: noSleep });

    await queue.enqueue("same", snapshot("same"));

    // Reusing revision 1 would be refused by the store's own monotonic rule if the
    // first attempt actually landed, so each attempt has to claim a new one.
    expect(attempts).toEqual([1, 2]);
    expect(onPersisted).toHaveBeenCalledTimes(1);
  });

  it("two tabs: a retried write adopts the other tab's copy instead of rebasing over it", async () => {
    // The server enforces a monotonic revision, exactly like the real route.
    // Both tabs share it, and both were loaded at revision 5.
    const server = {
      revision: 5,
      text: "",
      writes: [] as { revision: number; text: string }[],
      write(revision: number, text: string) {
        if (revision <= this.revision) {
          throw new HttpError("stale", 409, { error: "stale_revision", revision: this.revision });
        }
        this.revision = revision;
        this.text = text;
        this.writes.push({ revision, text });
      },
      read() {
        return { revision: this.revision, text: this.text };
      }
    };

    let releaseTabA!: () => void;
    const tabAInFlight = new Promise<void>((resolve) => {
      releaseTabA = resolve;
    });

    const adopted: { revision: number; text: string }[] = [];

    function tab(text: string, firstAttempt?: (request: SaveSessionRequest) => Promise<void>) {
      let attempts = 0;
      return new SessionSaveQueue(
        async (request) => {
          attempts += 1;
          if (attempts === 1 && firstAttempt) return firstAttempt(request);
          server.write(request.revision, text);
        },
        "initial",
        5,
        () => {},
        {
          sleep: noSleep,
          loadServerCopy: async () => {
            const copy = server.read();
            return { revision: copy.revision, messages: [userMessage(copy.text)] };
          },
          onConflictAdopted: (copy) => {
            const [part] = copy.messages[0].parts as { type: "text"; text: string }[];
            adopted.push({ revision: copy.revision, text: part.text });
          }
        }
      );
    }

    // Tab A's POST is in flight and comes back 504: the client cannot tell whether
    // the server ever applied it. That ambiguity is the whole problem.
    const tabA = tab("A-tab", async () => {
      await tabAInFlight;
      throw new HttpError("gateway timeout", 504, null);
    });
    // Tab B's first attempt simply lands.
    const tabB = tab("B-tab");

    // 1. Tab A enqueues at revision 6; its write hangs.
    const tabARun = tabA.enqueue(sessionSignature([userMessage("A-tab")]), {
      id: "shared",
      messages: [userMessage("A-tab")]
    });
    await Promise.resolve();

    // 2. Tab B, also at revision 6, saves first and the server accepts it.
    await tabB.enqueue(sessionSignature([userMessage("B-tab")]), {
      id: "shared",
      messages: [userMessage("B-tab")]
    });
    expect(server.text).toBe("B-tab");

    // 3. Tab A's write now fails transiently. Rebasing to revision 7 would be
    // accepted and would silently destroy tab B's chat.
    releaseTabA();
    await tabARun;

    expect(server.text).toBe("B-tab");
    expect(server.writes.map((write) => write.text)).toEqual(["B-tab"]);
    expect(adopted).toEqual([{ revision: 6, text: "B-tab" }]);
  });

  it("does not warn the user when a page-close flush cannot fit through keepalive", async () => {
    // Storage is fine and the ordinary throttle is still saving; the flush simply
    // cannot be made from an unloading page at this size. A warning here would be
    // a lie, and a fresh one on every tab switch.
    const oversize = Object.assign(new Error("body too large"), { isKeepaliveTooLarge: true });
    const persist = vi.fn().mockRejectedValue(oversize);
    const onPersistError = vi.fn();
    const onPersisted = vi.fn();
    const queue = new SessionSaveQueue(persist, "initial", 0, onPersisted, { sleep: noSleep });

    await queue.enqueue("partial", snapshot("partial"), { urgent: true });

    expect(persist).toHaveBeenCalledTimes(1);
    expect(onPersistError).not.toHaveBeenCalled();
    // Not acknowledged either: the next ordinary save still carries the snapshot.
    expect(onPersisted).not.toHaveBeenCalled();
    expect(queue.isAcknowledged("partial")).toBe(false);
  });

  it("reports which transcript is durably stored, so a redundant flush can be skipped", async () => {
    const queue = new SessionSaveQueue(vi.fn(async () => {}), "initial", 0, () => {}, { sleep: noSleep });

    expect(queue.isAcknowledged("initial")).toBe(true);
    expect(queue.isAcknowledged("something-else")).toBe(false);

    await queue.enqueue("next", snapshot("next"));
    expect(queue.isAcknowledged("next")).toBe(true);
  });

  it("a retry does not re-upload when the earlier attempt actually landed", async () => {
    const writes: number[] = [];
    const persist = vi.fn(async (request: SaveSessionRequest) => {
      writes.push(request.revision);
      if (writes.length === 1) throw new Error("connection reset after the write");
    });
    const onPersisted = vi.fn();
    const onConflictAdopted = vi.fn();
    const messages = [userMessage("landed anyway")];
    const queue = new SessionSaveQueue(persist, sessionSignature([]), 0, onPersisted, {
      sleep: noSleep,
      loadServerCopy: async () => ({ revision: 1, messages }),
      onConflictAdopted
    });

    await queue.enqueue(sessionSignature(messages), { id: "shared", messages });

    // Discovered by the probe rather than guessed: acknowledged, not re-sent, and
    // certainly not reported as someone else's copy.
    expect(writes).toEqual([1]);
    expect(onPersisted).toHaveBeenCalledTimes(1);
    expect(onConflictAdopted).not.toHaveBeenCalled();
  });

  it("does not rebase when the server's state cannot be determined", async () => {
    const writes: number[] = [];
    const persist = vi.fn(async (request: SaveSessionRequest) => {
      writes.push(request.revision);
      throw new Error("offline");
    });
    const onPersistError = vi.fn();
    const queue = new SessionSaveQueue(persist, sessionSignature([]), 0, () => {}, {
      sleep: noSleep,
      loadServerCopy: async () => {
        throw new Error("cannot reach the server");
      },
      onPersistError
    });

    await queue.enqueue("mine", snapshot("mine"));

    // Writing blind could destroy another tab's work, so the queue gives up and
    // leaves the snapshot unacknowledged instead.
    expect(writes).toEqual([1]);
    expect(onPersistError).not.toHaveBeenCalled();
  });

  it("prefers a newer queued snapshot over retrying stale data", async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const attempts: string[] = [];
    const persist = vi.fn(async (request: SaveSessionRequest) => {
      const id = request.messages[0]?.id as string;
      attempts.push(id);
      if (id === "a") {
        await first;
        throw new Error("flaky");
      }
    });
    const queue = new SessionSaveQueue(persist, "initial", 0, () => {}, { sleep: noSleep });

    const running = queue.enqueue("a", snapshot("a"));
    await Promise.resolve();
    void queue.enqueue("b", snapshot("b"));
    releaseFirst();
    await running;

    // "a" is not retried: "b" already contains everything "a" had.
    expect(attempts).toEqual(["a", "b"]);
  });

  it("does not retry a keepalive flush: the page is already going away", async () => {
    const persist = vi.fn().mockRejectedValue(new Error("offline"));
    const onPersisted = vi.fn();
    const delays: number[] = [];
    const queue = new SessionSaveQueue(persist, "initial", 0, onPersisted, {
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      }
    });

    await queue.enqueue("partial", snapshot("partial"), { urgent: true });

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }), { urgent: true });
    expect(delays).toEqual([]);
    expect(onPersisted).not.toHaveBeenCalled();
  });

  it("continues revisions loaded from persisted session state", async () => {
    const persist = vi.fn(async () => {});
    const queue = new SessionSaveQueue(persist, "initial", 7, () => {}, { sleep: noSleep });

    await queue.enqueue("next", snapshot("next"));

    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ revision: 8 }), { urgent: false });
  });

  it("adopts a newer revision observed when a session is loaded again", async () => {
    const persist = vi.fn(async () => {});
    const queue = new SessionSaveQueue(persist, "initial", 2, () => {}, { sleep: noSleep });

    queue.observeRevision(9);
    await queue.enqueue("next", snapshot("next"));

    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ revision: 10 }), { urgent: false });
  });

  it("adopts the other tab's newer copy instead of resending the stale one", async () => {
    const persist = vi.fn()
      .mockRejectedValueOnce(staleRevision(12))
      .mockResolvedValueOnce(undefined);
    const onPersisted = vi.fn();
    const onConflictAdopted = vi.fn();
    const queue = new SessionSaveQueue(persist, "initial", 4, onPersisted, {
      sleep: noSleep,
      loadServerCopy: async () => ({ revision: 12, messages: [{ id: "theirs", role: "user", parts: [] }] }),
      onConflictAdopted
    });

    await queue.enqueue("mine", snapshot("mine"));

    // Exactly one write: the stale snapshot is never rewritten over the winner.
    expect(persist).toHaveBeenCalledTimes(1);
    expect(onPersisted).not.toHaveBeenCalled();
    expect(onConflictAdopted).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 12, messages: [expect.objectContaining({ id: "theirs" })] })
    );
  });

  it("leaves the conflict unacknowledged when the authoritative copy cannot be loaded", async () => {
    const persist = vi.fn().mockRejectedValue(staleRevision(12));
    const onConflictAdopted = vi.fn();
    const queue = new SessionSaveQueue(persist, "initial", 4, () => {}, {
      sleep: noSleep,
      loadServerCopy: async () => null,
      onConflictAdopted
    });

    await queue.enqueue("mine", snapshot("mine"));

    expect(persist).toHaveBeenCalledTimes(1);
    expect(onConflictAdopted).not.toHaveBeenCalled();
  });

  it("two tabs saving the same next revision: the loser adopts the winner's copy", async () => {
    // Both tabs loaded rev 5; the other tab saved rev 6 first, so ours (also rev 6)
    // is rejected. Not adopting here would let our next save (rev 7) overwrite it.
    const persist = vi.fn().mockRejectedValue(staleRevision(6));
    const onConflictAdopted = vi.fn();
    const queue = new SessionSaveQueue(persist, "initial", 5, () => {}, {
      sleep: noSleep,
      loadServerCopy: async () => ({ revision: 6, messages: [{ id: "theirs", role: "user", parts: [] }] }),
      onConflictAdopted
    });

    await queue.enqueue("mine", snapshot("mine"));

    expect(persist).toHaveBeenCalledTimes(1);
    expect(onConflictAdopted).toHaveBeenCalledWith(expect.objectContaining({ revision: 6 }));
  });

  it("treats a conflict whose server copy is exactly ours as saved", async () => {
    const mine = snapshot("mine");
    const persist = vi.fn().mockRejectedValue(staleRevision(6));
    const onPersisted = vi.fn();
    const onConflictAdopted = vi.fn();
    const queue = new SessionSaveQueue(persist, "initial", 5, onPersisted, {
      sleep: noSleep,
      loadServerCopy: async () => ({ revision: 6, messages: mine.messages }),
      onConflictAdopted
    });
    const signature = sessionSignature(mine.messages);

    await queue.enqueue(signature, mine);

    expect(onConflictAdopted).not.toHaveBeenCalled();
    expect(queue.isAcknowledged(signature)).toBe(true);
  });

  it("counts a freshly loaded transcript as saved, so opening a chat does not rewrite it", async () => {
    const persist = vi.fn(async () => {});
    const queue = new SessionSaveQueue(persist, sessionSignature([]), 0, () => {}, { sleep: noSleep });
    const loaded = [userMessage("hello")];

    queue.observeLoaded(sessionSignature(loaded), 9);
    await queue.enqueue(sessionSignature(loaded), { id: "session", messages: loaded });
    expect(persist).not.toHaveBeenCalled();

    const next = [...loaded, userMessage("again")];
    await queue.enqueue(sessionSignature(next), { id: "session", messages: next });
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ revision: 10 }), { urgent: false });
  });

  it("does not adopt an older copy", async () => {
    const persist = vi.fn().mockRejectedValue(staleRevision(4));
    const onConflictAdopted = vi.fn();
    const queue = new SessionSaveQueue(persist, "initial", 4, () => {}, {
      sleep: noSleep,
      loadServerCopy: async () => ({ revision: 4, messages: [] }),
      onConflictAdopted
    });

    await queue.enqueue("mine", snapshot("mine"));

    expect(onConflictAdopted).not.toHaveBeenCalled();
  });

  it("gives up immediately on a deleted session instead of recreating it", async () => {
    const persist = vi.fn().mockRejectedValue(new HttpError("gone", 409, { error: "session_deleted" }));
    const onPersistError = vi.fn();
    const delays: number[] = [];
    const queue = new SessionSaveQueue(persist, "initial", 1, () => {}, {
      onPersistError,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      }
    });

    await queue.enqueue("gone", snapshot("gone"));

    expect(persist).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
    expect(onPersistError).toHaveBeenCalledTimes(1);
  });

  it("holds a conflict adoption while streaming and resolves it after the stream ends", async () => {
    let streaming = true;
    const persist = vi.fn().mockRejectedValue(staleRevision(6));
    const onConflictAdopted = vi.fn();
    const serverMessages = [{ id: "theirs", role: "user" as const, parts: [] }];
    const queue = new SessionSaveQueue(persist, "initial", 5, () => {}, {
      sleep: noSleep,
      isStreaming: () => streaming,
      loadServerCopy: async () => ({ revision: 6, messages: serverMessages }),
      onConflictAdopted
    });

    await queue.enqueue("mine", snapshot("mine"));

    // The server copy must not replace the transcript mid-stream.
    expect(persist).toHaveBeenCalledTimes(1);
    expect(onConflictAdopted).not.toHaveBeenCalled();

    // Nothing local changed while streaming: the held copy is adopted now.
    streaming = false;
    expect(queue.drainDeferredConflict("mine")).toBe("adopted");
    expect(onConflictAdopted).toHaveBeenCalledWith(expect.objectContaining({ revision: 6 }));
  });

  it("re-saves on top of the server revision when the stream moved the transcript", async () => {
    let streaming = true;
    const revisions: number[] = [];
    const persist = vi.fn(async (request: SaveSessionRequest) => {
      revisions.push(request.revision);
      if (revisions.length === 1) throw staleRevision(6);
    });
    const onConflictAdopted = vi.fn();
    const queue = new SessionSaveQueue(persist, "initial", 5, () => {}, {
      sleep: noSleep,
      isStreaming: () => streaming,
      loadServerCopy: async () => ({ revision: 6, messages: [{ id: "theirs", role: "user", parts: [] }] }),
      onConflictAdopted
    });

    await queue.enqueue("mine", snapshot("mine"));
    expect(onConflictAdopted).not.toHaveBeenCalled();

    // The stream appended turns, so the local transcript no longer matches the
    // failed save: observe the server revision and re-save locally on top.
    streaming = false;
    expect(queue.drainDeferredConflict("mine-plus-stream")).toBe("needs-resave");
    expect(onConflictAdopted).not.toHaveBeenCalled();

    await queue.enqueue("mine-plus-stream", snapshot("mine-plus-stream"));
    expect(revisions.at(-1)).toBe(7);
  });

  it("does not spend the server revision while a conflict waits out a stream", async () => {
    // The server is two revisions ahead (another tab saved twice). If the
    // deferral observed that revision eagerly, a save enqueued mid-stream -
    // e.g. the throttled mid-stream persist - would claim revision 11 for a
    // transcript that is about to be replaced. Held back, it claims 7: one
    // past our own last attempt, and the stream-end drain decides from there.
    let streaming = true;
    const revisions: number[] = [];
    const persist = vi.fn(async (request: SaveSessionRequest) => {
      revisions.push(request.revision);
      if (revisions.length === 1) throw staleRevision(10);
    });
    const onConflictAdopted = vi.fn();
    const queue = new SessionSaveQueue(persist, "initial", 5, () => {}, {
      sleep: noSleep,
      isStreaming: () => streaming,
      loadServerCopy: async () => ({ revision: 10, messages: [{ id: "theirs", role: "user", parts: [] }] }),
      onConflictAdopted
    });

    await queue.enqueue("mine", snapshot("mine"));
    expect(onConflictAdopted).not.toHaveBeenCalled();

    await queue.enqueue("mine-plus-stream", snapshot("mine-plus-stream"));
    expect(revisions).toEqual([6, 7]);
    expect(onConflictAdopted).not.toHaveBeenCalled();
    streaming = false;
  });

  it("keeps a 5xx failure for retry instead of dropping it silently", async () => {
    const persist = vi.fn().mockRejectedValue(new HttpError("server on fire", 500, null));
    const onPersistError = vi.fn();
    const queue = new SessionSaveQueue(persist, "initial", 0, () => {}, {
      sleep: noSleep,
      onPersistError
    });

    await queue.enqueue("first", snapshot("first"));

    expect(persist).toHaveBeenCalledTimes(4);
    expect(onPersistError).toHaveBeenCalledTimes(1);
    expect(queue.isAcknowledged("first")).toBe(false);
    expect(queue.hasUnsaved()).toBe(true);

    // The retry claims a fresh revision and lands.
    persist.mockResolvedValueOnce(undefined);
    expect(queue.retryUnsaved()).toBe(true);
    await vi.waitFor(() => expect(queue.isAcknowledged("first")).toBe(true));
    expect(queue.hasUnsaved()).toBe(false);
  });

  it("holds an offline failure without burning retries, then resends on retry", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    try {
      const persist = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      const onPersistError = vi.fn();
      const queue = new SessionSaveQueue(persist, "initial", 0, () => {}, {
        sleep: noSleep,
        onPersistError
      });

      await queue.enqueue("offline-work", snapshot("offline-work"));

      // One attempt, not four: nothing can succeed until the browser is back.
      expect(persist).toHaveBeenCalledTimes(1);
      expect(onPersistError).not.toHaveBeenCalled();
      expect(queue.hasUnsaved()).toBe(true);

      persist.mockResolvedValueOnce(undefined);
      expect(queue.retryUnsaved()).toBe(true);
      await vi.waitFor(() => expect(queue.isAcknowledged("offline-work")).toBe(true));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
