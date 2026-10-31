import { describe, expect, it } from "vitest";
import { evictSessions, MCP_SESSION_IDLE_MS, type SessionEntry } from "../session-store";

function fakeTransport() {
  return {
    closed: false,
    async close() {
      this.closed = true;
    }
  };
}

type FakeSession = SessionEntry<ReturnType<typeof fakeTransport>>;

describe("MCP session eviction", () => {
  it("closes and removes idle sessions, keeping active ones", async () => {
    const idle = fakeTransport();
    const active = fakeTransport();
    const now = 1_000_000;
    const sessions = new Map<string, FakeSession>([
      ["idle", { transport: idle, lastActive: now - MCP_SESSION_IDLE_MS }],
      ["active", { transport: active, lastActive: now }]
    ]);

    const evicted = await evictSessions(sessions, { now });

    expect(evicted).toEqual(["idle"]);
    expect(idle.closed).toBe(true);
    expect(active.closed).toBe(false);
    expect([...sessions.keys()]).toEqual(["active"]);
  });

  it("caps sessions by evicting the oldest first and closing them", async () => {
    const now = 1_000_000;
    const transports = [fakeTransport(), fakeTransport(), fakeTransport()];
    const sessions = new Map<string, FakeSession>([
      ["oldest", { transport: transports[0], lastActive: now - 3000 }],
      ["middle", { transport: transports[1], lastActive: now - 2000 }],
      ["newest", { transport: transports[2], lastActive: now - 1000 }]
    ]);

    const evicted = await evictSessions(sessions, { now, maxSessions: 2 });

    expect(evicted).toEqual(["oldest"]);
    expect(transports[0].closed).toBe(true);
    expect(transports[1].closed).toBe(false);
    expect(transports[2].closed).toBe(false);
    expect([...sessions.keys()].sort()).toEqual(["middle", "newest"]);
  });
});
