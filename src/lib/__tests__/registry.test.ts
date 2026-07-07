import { describe, expect, it } from "vitest";
import { resolveComponent } from "../registry";
import type Database from "better-sqlite3";

describe("resolveComponent research lookup", () => {
  it("scopes research lookup by category before choosing the newest row", () => {
    const rows = [
      { key: "lookup-mask-key", category: "gpu", specs: JSON.stringify({ brand: "Wrong", model: "GPU", aliases: [] }), sources: "[]", confidence: "medium", researched_at: "2026-02-01T00:00:00.000Z" },
      { key: "older-correct-component", category: "cpu", specs: JSON.stringify({ brand: "Right", model: "CPU", aliases: [], socket: "AM5" }), sources: "[]", confidence: "medium", researched_at: "2026-01-01T00:00:00.000Z" }
    ];
    const db = {
      prepare: (sql: string) => ({
        get: (key: string, slug: string, category?: string) => rows
          .filter((row) => row.key === key || row.key === slug)
          .filter((row) => !sql.includes("category = ?") || row.category === category)
          .sort((a, b) => b.researched_at.localeCompare(a.researched_at))[0]
      })
    };

    const resolved = resolveComponent({ key: "lookup-mask-key", name: "Older Correct Component", category: "cpu" }, { db: db as unknown as Database.Database });
    expect(resolved).toMatchObject({ key: "older-correct-component", category: "cpu", spec: expect.objectContaining({ socket: "AM5" }) });
  });
});
