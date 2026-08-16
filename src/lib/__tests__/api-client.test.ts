import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteSession,
  fetchSession,
  importProfileFromFile,
  normalizeUIMessage,
  postSse,
  probeEntry,
  requestJson,
  requestOk,
  saveSession
} from "../api-client";

const successOutcome = {
  status: "succeeded" as const,
  jobs_total: 1,
  jobs_succeeded: 1,
  jobs_failed: 0,
  jobs_skipped: 0,
  products_written: 4,
  errors: []
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("JSON request acknowledgement", () => {
  it.each([400, 404, 500])("rejects HTTP %s even when the body is JSON", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status,
      headers: { "content-type": "application/json" }
    })));

    await expect(requestOk("/api/example")).rejects.toMatchObject({ status });
  });

  it("rejects malformed success JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 200 })));

    await expect(requestJson("/api/example")).rejects.toThrow("malformed JSON");
  });

  it("preserves network and abort failures", async () => {
    const networkError = new TypeError("network unavailable");
    vi.stubGlobal("fetch", vi.fn(async () => { throw networkError; }));
    await expect(requestJson("/api/example")).rejects.toBe(networkError);

    const abortError = new DOMException("Aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn(async () => { throw abortError; }));
    await expect(requestJson("/api/example", { signal: new AbortController().signal })).rejects.toBe(abortError);
  });

  it("requires an exact ok acknowledgement", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false })));

    await expect(requestOk("/api/example")).rejects.toThrow("invalid response");
  });
});

describe("high-risk API contracts", () => {
  it("rejects malformed probe success data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ reachable: true })));

    await expect(probeEntry({
      provider: "gemini",
      model: "model",
      keySource: "env"
    })).rejects.toThrow("invalid response");
  });

  it("selects the exact id returned by profile import", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, id: "server-chosen-id" })));

    await expect(importProfileFromFile(new File(["{}"], "different-name.json"))).resolves.toEqual({
      ok: true,
      id: "server-chosen-id"
    });
  });

  it("retries failed session saves and validates the echoed revision", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "write_failed" }, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ ok: true, revision: 7 }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { id: "s1", revision: 7, messages: [] };

    await expect(saveSession(input)).rejects.toMatchObject({ status: 500 });
    await expect(saveSession(input)).resolves.toBeUndefined();
  });

  it("does not acknowledge a different save revision", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, revision: 6 })));

    await expect(saveSession({ id: "s1", revision: 7, messages: [] })).rejects.toThrow("invalid response");
  });

  it("retries a failed delete", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "delete_failed" }, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ ok: true })));

    await expect(deleteSession("s1")).rejects.toMatchObject({ status: 500 });
    await expect(deleteSession("s1")).resolves.toBeUndefined();
  });
});

describe("scrape terminal outcomes", () => {
  it("returns exactly one valid terminal outcome", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      ["progress", { type: "progress", site: "shop", percent: 50 }],
      ["outcome", { type: "outcome", outcome: successOutcome }]
    ])));
    const events: string[] = [];

    await expect(postSse("/api/scrape", {}, (event) => events.push(event))).resolves.toEqual(successOutcome);
    expect(events).toEqual(["progress"]);
  });

  it("rejects error-before-close when no terminal outcome arrives", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      ["error", { error: "child failed" }]
    ])));
    const events: string[] = [];

    await expect(postSse("/api/scrape", {}, (event) => events.push(event))).rejects.toThrow(
      "closed without a terminal outcome"
    );
    expect(events).toEqual(["error"]);
  });

  it("rejects duplicate terminal outcomes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      ["outcome", { type: "outcome", outcome: successOutcome }],
      ["outcome", { type: "outcome", outcome: successOutcome }]
    ])));

    await expect(postSse("/api/scrape", {}, () => undefined)).rejects.toThrow("more than one terminal outcome");
  });
});

describe("normalizeUIMessage", () => {
  it("converts legacy string content to text parts and generates missing id", () => {
    const legacy = { role: "user", content: "Build a pc" };
    const normalized = normalizeUIMessage(legacy, 0);

    expect(normalized.role).toBe("user");
    expect(normalized.id).toBeDefined();
    expect(normalized.parts).toEqual([{ type: "text", text: "Build a pc" }]);
  });

  it("preserves modern UIMessage parts and id", () => {
    const modern = {
      id: "msg-123",
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: "Here is your build" }]
    };
    const normalized = normalizeUIMessage(modern, 0);

    expect(normalized.id).toBe("msg-123");
    expect(normalized.role).toBe("assistant");
    expect(normalized.parts).toEqual([{ type: "text", text: "Here is your build" }]);
  });
});

describe("fetchSession", () => {
  it("normalizes legacy messages in session payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            session: {
              id: "sess-1",
              revision: 1,
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
              messages: [{ role: "user", content: "Hello world" }]
            }
          }),
          { headers: { "content-type": "application/json" } }
        )
      )
    );

    const result = await fetchSession("sess-1");
    expect(result).not.toBeNull();
    expect(result!.messages[0].id).toBeDefined();
    expect(result!.messages[0].parts).toEqual([{ type: "text", text: "Hello world" }]);
  });
});

function sseResponse(frames: Array<[string, unknown]>): Response {
  const body = frames
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
