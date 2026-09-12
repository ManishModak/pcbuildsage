import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("better-sqlite3", async (importOriginal) => {
  const original = await importOriginal<typeof import("better-sqlite3")>();
  const ActualDatabase = typeof original === "function" ? original : (original as { default: typeof original }).default;
  class WrappedDatabase extends ActualDatabase {
    constructor(dbPath: string, options?: unknown) {
      super(":memory:", options as Parameters<typeof ActualDatabase>[1]);
    }
  }
  return {
    default: WrappedDatabase
  };
});

import { GET as listRoute, POST as saveRoute } from "../route";
import { GET as getRoute, DELETE as deleteRoute } from "../[id]/route";
import { getSessionsDb } from "@/lib/sessions";

describe("Server Sessions Routes Dual-Mode Policy", () => {
  const originalEnv = process.env.PCBUILDSAGE_DEPLOYMENT_MODE;

  beforeEach(() => {
    const db = getSessionsDb();
    db.exec("DELETE FROM sessions");
    db.exec("DELETE FROM session_tombstones");
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = originalEnv;
    } else {
      delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
    }
  });

  describe("In hosted-demo mode", () => {
    beforeEach(() => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    });

    it("rejects GET /api/sessions with 403 Forbidden", async () => {
      const response = await listRoute();
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data).toEqual({
        error: "forbidden",
        message: "Server-side sessions are disabled in hosted demo mode. Chat history is stored locally in your browser."
      });
    });

    it("rejects POST /api/sessions with 403 Forbidden", async () => {
      const request = new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "s1",
          revision: 1,
          messages: []
        })
      });
      const response = await saveRoute(request);
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data).toEqual({
        error: "forbidden",
        message: "Server-side sessions are disabled in hosted demo mode. Chat history is stored locally in your browser."
      });
    });

    it("rejects GET /api/sessions/[id] with 403 Forbidden", async () => {
      const request = new Request("http://localhost/api/sessions/s1");
      const response = await getRoute(request, { params: Promise.resolve({ id: "s1" }) });
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data).toEqual({
        error: "forbidden",
        message: "Server-side sessions are disabled in hosted demo mode. Chat history is stored locally in your browser."
      });
    });

    it("rejects DELETE /api/sessions/[id] with 403 Forbidden", async () => {
      const request = new Request("http://localhost/api/sessions/s1", { method: "DELETE" });
      const response = await deleteRoute(request, { params: Promise.resolve({ id: "s1" }) });
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data).toEqual({
        error: "forbidden",
        message: "Server-side sessions are disabled in hosted demo mode. Chat history is stored locally in your browser."
      });
    });
  });

  describe("In local mode", () => {
    beforeEach(() => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "local";
    });

    it("allows full session lifecycle with SQLite in local mode", async () => {
      // 1. Initially empty list
      const list1 = await (await listRoute()).json();
      expect(list1.sessions).toEqual([]);

      // 2. Save session
      const saveReq = new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "local-sess-1",
          revision: 1,
          title: "Local Gaming Build",
          messages: [
            {
              id: "m1",
              role: "user",
              content: "Build request"
            }
          ]
        })
      });
      const saveRes = await saveRoute(saveReq);
      expect(saveRes.status).toBe(200);
      expect(await saveRes.json()).toEqual({ ok: true, revision: 1 });

      // 3. Get session by ID
      const getReq = new Request("http://localhost/api/sessions/local-sess-1");
      const getRes = await getRoute(getReq, { params: Promise.resolve({ id: "local-sess-1" }) });
      expect(getRes.status).toBe(200);
      const sessionData = await getRes.json();
      expect(sessionData.session.id).toBe("local-sess-1");
      expect(sessionData.session.title).toBe("Local Gaming Build");

      // 4. List sessions
      const list2 = await (await listRoute()).json();
      expect(list2.sessions.length).toBe(1);
      expect(list2.sessions[0].id).toBe("local-sess-1");

      // 5. Delete session
      const delReq = new Request("http://localhost/api/sessions/local-sess-1", { method: "DELETE" });
      const delRes = await deleteRoute(delReq, { params: Promise.resolve({ id: "local-sess-1" }) });
      expect(delRes.status).toBe(200);
      expect(await delRes.json()).toEqual({ ok: true });

      // 6. Verify deleted
      const getDeleted = await getRoute(getReq, { params: Promise.resolve({ id: "local-sess-1" }) });
      expect(getDeleted.status).toBe(404);
    });
  });
});
