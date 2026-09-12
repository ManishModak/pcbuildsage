import { describe, it, expect } from "vitest";
import { MockBrowserSessionStore, SessionDetail } from "../test-harness";

describe("Tier 2 Boundary - Feature 18: Browser Session Storage Boundaries", () => {
  it("handles storage quota exceeded errors gracefully", async () => {
    const store = new MockBrowserSessionStore();
    store.quotaLimit = 100; // tiny 100-byte quota

    const bigSession: SessionDetail = {
      id: "big-sess",
      title: "Huge Session " + "A".repeat(500),
      createdAt: "2026-09-02T10:00:00Z",
      updatedAt: "2026-09-02T10:00:00Z",
      messageCount: 1,
      messages: [{ id: "m1", role: "user", content: "Big content", timestamp: "2026-09-02T10:00:00Z" }]
    };

    await expect(store.saveSession(bigSession)).rejects.toThrow("QuotaExceededError");
  });

  it("handles saving sessions with 1,000 messages within quota", async () => {
    const store = new MockBrowserSessionStore();
    const messages = Array.from({ length: 1000 }, (_, i) => ({
      id: `m-${i}`,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `Message ${i}`,
      timestamp: new Date().toISOString()
    }));

    const session: SessionDetail = {
      id: "large-chat",
      title: "Long conversation",
      createdAt: "2026-09-02T10:00:00Z",
      updatedAt: "2026-09-02T11:00:00Z",
      messageCount: 1000,
      messages
    };

    await store.saveSession(session);
    const retrieved = await store.getSession("large-chat");
    expect(retrieved?.messages.length).toBe(1000);
  });

  it("handles special characters and emoji in session title and message content", async () => {
    const store = new MockBrowserSessionStore();
    const session: SessionDetail = {
      id: "emoji-sess",
      title: "🚀 Super Fast Gaming Rig 🖥️",
      createdAt: "2026-09-02T10:00:00Z",
      updatedAt: "2026-09-02T10:00:00Z",
      messageCount: 1,
      messages: [{ id: "m1", role: "user", content: "🔥 RGB build with <script>alert(1)</script>", timestamp: "2026-09-02T10:00:00Z" }]
    };

    await store.saveSession(session);
    const retrieved = await store.getSession("emoji-sess");
    expect(retrieved?.title).toBe("🚀 Super Fast Gaming Rig 🖥️");
    expect(retrieved?.messages[0].content).toContain("🔥 RGB");
  });

  it("handles deleting non-existent session ID without throwing error", async () => {
    const store = new MockBrowserSessionStore();
    await expect(store.deleteSession("non-existent")).resolves.toBeUndefined();
  });

  it("updates existing session in place when saving with same ID", async () => {
    const store = new MockBrowserSessionStore();
    const s1: SessionDetail = {
      id: "s1",
      title: "Initial Title",
      createdAt: "2026-09-02T10:00:00Z",
      updatedAt: "2026-09-02T10:00:00Z",
      messageCount: 0,
      messages: []
    };
    await store.saveSession(s1);

    const s1Updated: SessionDetail = {
      ...s1,
      title: "Updated Title",
      updatedAt: "2026-09-02T10:10:00Z"
    };
    await store.saveSession(s1Updated);

    const retrieved = await store.getSession("s1");
    expect(retrieved?.title).toBe("Updated Title");
    const list = await store.listSessions();
    expect(list.length).toBe(1);
  });
});
