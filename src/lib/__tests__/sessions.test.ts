import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { deleteSession, getSession, listSessions, saveSession, getSessionsDb } from "../sessions";

describe("sessions store", () => {
  beforeEach(() => {
    const db = getSessionsDb();
    db.exec("DELETE FROM sessions");
    db.exec("DELETE FROM session_tombstones");
    vi.useRealTimers();
  });

  it("round-trips the full messages array through save -> getSession", () => {
    const messages = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "1440p build under 90k" }] },
      {
        id: "m2",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Consider GPU first per the cascade." },
          { type: "tool-search_products", state: "output-available", output: { results: [{ id: "gpu-1", price: 4600 }] } },
          { type: "text", text: "Here is a build." }
        ]
      }
    ];

    saveSession({ id: "s1", revision: 1, messages, title: "1440p build", countryCode: "IN", currency: "INR" });

    const got = getSession("s1");
    expect(got).not.toBeNull();
    expect(got!.messages).toEqual(messages);
    expect(got!.title).toBe("1440p build");
    expect(got!.country_code).toBe("IN");
    expect(got!.currency).toBe("INR");
    expect(got!.revision).toBe(1);
  });

  it("upserts on conflict, keeping created_at and refreshing messages", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    saveSession({ id: "s1", revision: 1, messages: [{ id: "a", role: "user", parts: [] }], title: "First" });
    const created = getSession("s1")!.created_at;

    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    saveSession({ id: "s1", revision: 2, messages: [{ id: "b", role: "user", parts: [] }], title: "Second" });

    const got = getSession("s1")!;
    expect(got.created_at).toBe(created);
    expect(got.updated_at).toBe("2026-01-02T00:00:00.000Z");
    expect(got.title).toBe("Second");
    expect(got.messages).toEqual([{ id: "b", role: "user", parts: [] }]);
  });

  it("lists sessions ordered by updated_at descending", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    saveSession({ id: "a", revision: 1, messages: [], title: "A" });
    vi.setSystemTime(new Date("2026-01-03T00:00:00.000Z"));
    saveSession({ id: "b", revision: 1, messages: [], title: "B" });
    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    saveSession({ id: "c", revision: 1, messages: [], title: "C" });

    const list = listSessions();
    expect(list.map((session) => session.id)).toEqual(["b", "c", "a"]);
    // The list is light: no messages blob.
    expect(list[0]).not.toHaveProperty("messages");
  });

  it("deleteSession removes the row", () => {
    saveSession({ id: "gone", revision: 1, messages: [] });
    expect(getSession("gone")).not.toBeNull();

    deleteSession("gone");
    expect(getSession("gone")).toBeNull();
    expect(saveSession({ id: "gone", revision: 2, messages: [] })).toEqual({ status: "deleted" });
  });

  it("returns null for a missing session", () => {
    expect(getSession("nope")).toBeNull();
  });

  it("isolates a corrupt row without breaking other sessions", () => {
    saveSession({ id: "healthy", revision: 1, messages: [{ id: "ok" }] });
    const db = getSessionsDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO sessions (id, created_at, updated_at, messages) VALUES (?, ?, ?, ?)`
    ).run("broken", now, now, "not-json");

    expect(() => getSession("broken")).toThrow("Session broken contains invalid stored data");
    expect(getSession("healthy")?.messages).toEqual([{ id: "ok" }]);
    expect(listSessions().map((session) => session.id)).toEqual(expect.arrayContaining(["healthy", "broken"]));
  });

  it("rejects stale revisions without overwriting newer messages", () => {
    expect(saveSession({ id: "ordered", revision: 2, messages: [{ id: "new" }] })).toEqual({
      status: "saved",
      revision: 2
    });
    expect(saveSession({ id: "ordered", revision: 1, messages: [{ id: "old" }] })).toEqual({
      status: "stale",
      revision: 2
    });
    expect(getSession("ordered")?.messages).toEqual([{ id: "new" }]);
  });

  it("explicitly sets/clears nullable fields (title, country_code, currency) to NULL when requested", () => {
    saveSession({
      id: "clearable",
      revision: 1,
      messages: [{ id: "m1" }],
      title: "Original Title",
      countryCode: "US",
      currency: "USD"
    });

    const s1 = getSession("clearable")!;
    expect(s1.title).toBe("Original Title");
    expect(s1.country_code).toBe("US");
    expect(s1.currency).toBe("USD");

    // Explicitly set title, countryCode, and currency to null
    saveSession({
      id: "clearable",
      revision: 2,
      title: null,
      countryCode: null,
      currency: null
    });

    const s2 = getSession("clearable")!;
    expect(s2.title).toBeNull();
    expect(s2.country_code).toBeNull();
    expect(s2.currency).toBeNull();
    expect(s2.messages).toEqual([{ id: "m1" }]);
  });
});
