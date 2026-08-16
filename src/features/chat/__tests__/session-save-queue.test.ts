import { describe, expect, it, vi } from "vitest";
import { HttpError, type SaveSessionRequest } from "@/lib/api-client";
import { SessionSaveQueue } from "../session-save-queue";

function snapshot(messageId: string) {
  return {
    id: "session",
    messages: [{ id: messageId, role: "user" as const, parts: [] }]
  };
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
    const queue = new SessionSaveQueue(persist, "initial", 0, onPersisted);

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
    const queue = new SessionSaveQueue(persist, "initial", 0, onPersisted);

    await queue.enqueue("same", snapshot("same"));

    expect(persist).toHaveBeenCalledTimes(2);
    expect(onPersisted).toHaveBeenCalledTimes(1);
  });

  it("keeps a twice-failed signature retryable by a later enqueue", async () => {
    const persist = vi.fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockRejectedValueOnce(new Error("still full"))
      .mockResolvedValueOnce(undefined);
    const onPersisted = vi.fn();
    const queue = new SessionSaveQueue(persist, "initial", 0, onPersisted);

    await queue.enqueue("same", snapshot("same"));
    expect(onPersisted).not.toHaveBeenCalled();
    await queue.enqueue("same", snapshot("same"));

    expect(persist).toHaveBeenCalledTimes(3);
    expect(onPersisted).toHaveBeenCalledTimes(1);
  });

  it("continues revisions loaded from persisted session state", async () => {
    const persist = vi.fn(async () => {});
    const queue = new SessionSaveQueue(persist, "initial", 7);

    await queue.enqueue("next", snapshot("next"));

    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ revision: 8 }));
  });

  it("adopts a newer revision observed when a session is loaded again", async () => {
    const persist = vi.fn(async () => {});
    const queue = new SessionSaveQueue(persist, "initial", 2);

    queue.observeRevision(9);
    await queue.enqueue("next", snapshot("next"));

    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ revision: 10 }));
  });

  it("rebases once when another local client advanced the revision", async () => {
    const persist = vi.fn()
      .mockRejectedValueOnce(new HttpError("stale", 409, { error: "stale_revision", revision: 12 }))
      .mockResolvedValueOnce(undefined);
    const onPersisted = vi.fn();
    const queue = new SessionSaveQueue(persist, "initial", 4, onPersisted);

    await queue.enqueue("next", snapshot("next"));

    expect(persist.mock.calls.map(([request]) => request.revision)).toEqual([5, 13]);
    expect(onPersisted).toHaveBeenCalledTimes(1);
  });
});
