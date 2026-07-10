import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors search-products.test.ts: instead of a real database we mock the
// low-level driver (better-sqlite3) that sessions.ts opens, and reimplement
// just the SQL semantics sessions.ts relies on over an in-memory Map. This
// exercises the REAL sessions.ts logic (getSessionsDb, upsert, JSON
// (de)serialization, ordering) without touching disk.

type StoredRow = {
  id: string;
  created_at: string;
  updated_at: string;
  title: string | null;
  country_code: string | null;
  currency: string | null;
  messages: string;
  build_state: string | null;
};

const state = vi.hoisted(() => ({
  rows: new Map<string, StoredRow>()
}));

vi.mock("better-sqlite3", () => {
  class FakeStatement {
    constructor(private readonly sql: string) {}

    run(...params: unknown[]) {
      if (/INSERT INTO sessions/i.test(this.sql)) {
        const [id, created_at, updated_at, title, country_code, currency, messages, build_state] = params as [
          string,
          string,
          string,
          string | null,
          string | null,
          string | null,
          string,
          string | null
        ];
        const existing = state.rows.get(id);
        if (existing) {
          // ON CONFLICT(id) DO UPDATE: created_at stays, everything else refreshes.
          state.rows.set(id, { ...existing, updated_at, title, country_code, currency, messages, build_state });
        } else {
          state.rows.set(id, { id, created_at, updated_at, title, country_code, currency, messages, build_state });
        }
        return { changes: 1 };
      }
      if (/DELETE FROM sessions/i.test(this.sql)) {
        const [id] = params as [string];
        const existed = state.rows.delete(id);
        return { changes: existed ? 1 : 0 };
      }
      return { changes: 0 };
    }

    get(...params: unknown[]) {
      if (/SELECT \* FROM sessions WHERE id/i.test(this.sql)) {
        const [id] = params as [string];
        return state.rows.get(id);
      }
      return undefined;
    }

    all() {
      if (/ORDER BY updated_at DESC/i.test(this.sql)) {
        return [...state.rows.values()]
          .map((row) => ({ id: row.id, title: row.title, created_at: row.created_at, updated_at: row.updated_at }))
          .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
      }
      return [];
    }
  }

  class FakeDatabase {
    open = true;
    pragma() {}
    exec() {}
    prepare(sql: string) {
      return new FakeStatement(sql);
    }
    close() {
      this.open = false;
    }
  }

  return { default: FakeDatabase };
});

import { deleteSession, getSession, listSessions, saveSession } from "../sessions";

describe("sessions store", () => {
  beforeEach(() => {
    state.rows.clear();
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
          { type: "tool-search_products", state: "output-available", output: { results: [{ id: "gpu-1", price_minor: 460000 }] } },
          { type: "text", text: "Here is a build." }
        ]
      }
    ];

    saveSession({ id: "s1", messages, title: "1440p build", countryCode: "IN", currency: "INR" });

    const got = getSession("s1");
    expect(got).not.toBeNull();
    expect(got!.messages).toEqual(messages);
    expect(got!.title).toBe("1440p build");
    expect(got!.country_code).toBe("IN");
    expect(got!.currency).toBe("INR");
  });

  it("upserts on conflict, keeping created_at and refreshing messages", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    saveSession({ id: "s1", messages: [{ id: "a", role: "user", parts: [] }], title: "First" });
    const created = getSession("s1")!.created_at;

    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    saveSession({ id: "s1", messages: [{ id: "b", role: "user", parts: [] }], title: "Second" });

    const got = getSession("s1")!;
    expect(got.created_at).toBe(created);
    expect(got.updated_at).toBe("2026-01-02T00:00:00.000Z");
    expect(got.title).toBe("Second");
    expect(got.messages).toEqual([{ id: "b", role: "user", parts: [] }]);
  });

  it("lists sessions ordered by updated_at descending", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    saveSession({ id: "a", messages: [], title: "A" });
    vi.setSystemTime(new Date("2026-01-03T00:00:00.000Z"));
    saveSession({ id: "b", messages: [], title: "B" });
    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    saveSession({ id: "c", messages: [], title: "C" });

    const list = listSessions();
    expect(list.map((session) => session.id)).toEqual(["b", "c", "a"]);
    // The list is light: no messages blob.
    expect(list[0]).not.toHaveProperty("messages");
  });

  it("deleteSession removes the row", () => {
    saveSession({ id: "gone", messages: [] });
    expect(getSession("gone")).not.toBeNull();

    deleteSession("gone");
    expect(getSession("gone")).toBeNull();
  });

  it("returns null for a missing session", () => {
    expect(getSession("nope")).toBeNull();
  });
});
