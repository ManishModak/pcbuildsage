import { describe, expect, it, vi } from "vitest";
import { HttpError, type SaveSessionRequest } from "@/lib/api-client";
import { SessionSaveQueue } from "../session-save-queue";

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

  it("does not adopt an older or equal copy", async () => {
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
});
