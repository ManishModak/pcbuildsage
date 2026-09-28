/**
 * src/lib/analytics/__tests__/client-events.test.ts
 *
 * M2: the browser helper posts exactly the allow-listed client events to
 * /api/metrics and never breaks the UI when the network fails. No DOM needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordClientEvent } from "@/lib/analytics/client";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recordClientEvent", () => {
  it("POSTs landing_view and onboarding_completed to /api/metrics", async () => {
    await recordClientEvent("landing_view");
    await recordClientEvent("onboarding_completed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(url).toBe("/api/metrics");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    }
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ event: "landing_view" });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({ event: "onboarding_completed" });
  });

  it("never rejects, even when the network fails", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(recordClientEvent("landing_view")).resolves.toBeUndefined();
  });

  it("ignores events outside the allow-list without fetching", async () => {
    await recordClientEvent("chat_started" as never);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
