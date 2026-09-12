import { describe, it, expect } from "vitest";
import { MockBrowserSessionStore, SessionDetail } from "../test-harness";

describe("Tier 1 - Feature 18: Browser-Owned Session Storage (R4)", () => {
  it("saves a new chat session to client-side storage without server persistence", async () => {
    const store = new MockBrowserSessionStore();
    const session: SessionDetail = {
      id: "sess-101",
      title: "Gaming PC Build $1500",
      createdAt: "2026-09-02T10:00:00Z",
      updatedAt: "2026-09-02T10:05:00Z",
      messageCount: 2,
      messages: [
        { id: "m1", role: "user", content: "Build me a gaming PC", timestamp: "2026-09-02T10:00:00Z" },
        { id: "m2", role: "assistant", content: "Here is a great build...", timestamp: "2026-09-02T10:05:00Z" }
      ]
    };

    await store.saveSession(session);
    const retrieved = await store.getSession("sess-101");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe("sess-101");
    expect(retrieved?.messages.length).toBe(2);
  });

  it("lists all locally saved sessions sorted by updatedAt descending", async () => {
    const store = new MockBrowserSessionStore();
    const s1: SessionDetail = {
      id: "s1",
      title: "Earlier Session",
      createdAt: "2026-09-01T10:00:00Z",
      updatedAt: "2026-09-01T10:00:00Z",
      messageCount: 1,
      messages: []
    };
    const s2: SessionDetail = {
      id: "s2",
      title: "Later Session",
      createdAt: "2026-09-02T12:00:00Z",
      updatedAt: "2026-09-02T12:00:00Z",
      messageCount: 1,
      messages: []
    };

    await store.saveSession(s1);
    await store.saveSession(s2);

    const list = await store.listSessions();
    expect(list.length).toBe(2);
    expect(list[0].id).toBe("s2");
    expect(list[1].id).toBe("s1");
  });

  it("deletes a session by ID from client storage", async () => {
    const store = new MockBrowserSessionStore();
    const s1: SessionDetail = {
      id: "s1",
      title: "Session to Delete",
      createdAt: "2026-09-02T10:00:00Z",
      updatedAt: "2026-09-02T10:00:00Z",
      messageCount: 0,
      messages: []
    };

    await store.saveSession(s1);
    await store.deleteSession("s1");

    const retrieved = await store.getSession("s1");
    expect(retrieved).toBeNull();
  });

  it("returns null when attempting to get non-existent session ID", async () => {
    const store = new MockBrowserSessionStore();
    const retrieved = await store.getSession("non-existent-id");
    expect(retrieved).toBeNull();
  });

  it("clears all client sessions upon user reset", async () => {
    const store = new MockBrowserSessionStore();
    await store.saveSession({
      id: "s1",
      title: "S1",
      createdAt: "2026-09-02T10:00:00Z",
      updatedAt: "2026-09-02T10:00:00Z",
      messageCount: 0,
      messages: []
    });

    await store.clear();
    const list = await store.listSessions();
    expect(list.length).toBe(0);
  });
});
