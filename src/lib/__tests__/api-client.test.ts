import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearClientSessions,
  deleteSession,
  fetchHealth,
  fetchSession,
  fetchSessions,
  fetchStatus,
  importProfileFromFile,
  isHostedMode,
  normalizeUIMessage,
  postSse,
  probeEntry,
  requestJson,
  requestOk,
  resetCachedDeploymentMode,
  saveSession,
  setCachedDeploymentMode
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

beforeEach(async () => {
  resetCachedDeploymentMode();
  await clearClientSessions();
});

afterEach(async () => {
  resetCachedDeploymentMode();
  await clearClientSessions();
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

describe("isHostedMode", () => {
  const originalNextPublic = process.env.NEXT_PUBLIC_DEPLOYMENT_MODE;
  const originalPcMode = process.env.PCBUILDSAGE_DEPLOYMENT_MODE;

  afterEach(() => {
    if (originalNextPublic !== undefined) {
      process.env.NEXT_PUBLIC_DEPLOYMENT_MODE = originalNextPublic;
    } else {
      delete process.env.NEXT_PUBLIC_DEPLOYMENT_MODE;
    }
    if (originalPcMode !== undefined) {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = originalPcMode;
    } else {
      delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
    }
    resetCachedDeploymentMode();
  });

  it("defaults to false when no environment or cache is set", () => {
    delete process.env.NEXT_PUBLIC_DEPLOYMENT_MODE;
    delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
    resetCachedDeploymentMode();
    expect(isHostedMode()).toBe(false);
  });

  it("returns true when NEXT_PUBLIC_DEPLOYMENT_MODE is hosted-demo", () => {
    process.env.NEXT_PUBLIC_DEPLOYMENT_MODE = "hosted-demo";
    expect(isHostedMode()).toBe(true);
  });

  it("caches mode from fetchHealth response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status: "ok", mode: "hosted-demo", timestamp: "2026-09-03" }))
    );

    expect(isHostedMode()).toBe(false);
    await fetchHealth();
    expect(isHostedMode()).toBe(true);
  });

  it("caches mode from fetchStatus response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          status: "ok",
          deploymentMode: "hosted-demo",
          database: { exists: true, rowCounts: [] }
        })
      )
    );

    expect(isHostedMode()).toBe(false);
    await fetchStatus();
    expect(isHostedMode()).toBe(true);
  });
});

describe("Hosted Demo & 403 Fallback Delegation", () => {
  it("delegates save, list, get, delete to client-store when isHostedMode is true without making fetch calls", async () => {
    setCachedDeploymentMode("hosted-demo");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // Save session
    await saveSession({
      id: "hosted-sess-1",
      revision: 1,
      title: "Client Only Session",
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Client message" }] }]
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // List sessions
    const list = await fetchSessions();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe("hosted-sess-1");
    expect(list[0].title).toBe("Client Only Session");

    // Fetch session
    const detail = await fetchSession("hosted-sess-1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe("hosted-sess-1");
    expect(detail?.messages.length).toBe(1);

    // Delete session
    await deleteSession("hosted-sess-1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await fetchSession("hosted-sess-1")).toBeNull();
  });

  it("falls back to client-store when server session endpoints return HTTP 403", async () => {
    // Start in unknown/local mode
    resetCachedDeploymentMode();

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: "forbidden",
          message: "Server-side sessions are disabled in hosted demo mode. Chat history is stored locally in your browser."
        }),
        { status: 403, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    // 1. saveSession gets 403, falls back to client store, and sets cached mode
    await expect(
      saveSession({
        id: "fallback-sess-1",
        revision: 1,
        title: "Fallback Session",
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Fallback text" }] }]
      })
    ).resolves.toBeUndefined();

    expect(isHostedMode()).toBe(true);

    // 2. Now subsequent calls directly use client-store
    fetchMock.mockClear();
    const list = await fetchSessions();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe("fallback-sess-1");

    const detail = await fetchSession("fallback-sess-1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(detail?.title).toBe("Fallback Session");

    await deleteSession("fallback-sess-1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await fetchSession("fallback-sess-1")).toBeNull();
  });

  it("falls back to client-store when fetchSessions gets initial 403", async () => {
    resetCachedDeploymentMode();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: "forbidden" }),
          { status: 403, headers: { "content-type": "application/json" } }
        )
      )
    );

    const list = await fetchSessions();
    expect(list).toEqual([]);
    expect(isHostedMode()).toBe(true);
  });
});

function sseResponse(frames: Array<[string, unknown]>): Response {
  const body = frames
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
