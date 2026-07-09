import { afterAll, describe, expect, it, vi } from "vitest";
import { closeDb } from "../db";
import { exportResearch } from "../export-research";

const state = vi.hoisted(() => ({
  rows: [] as unknown[]
}));

vi.mock("../db", () => ({
  closeDb: vi.fn(),
  getDb: () => ({
    prepare: () => ({
      all: () => state.rows
    })
  })
}));

afterAll(() => {
  closeDb();
});

describe("exportResearch", () => {
  it("rejects unsafe registry research categories before writing files", () => {
    state.rows = [{
      key: "bad-key",
      category: "../evil",
      specs: "{}",
      sources: "[]",
      confidence: "low",
      researched_at: "2026-01-01T00:00:00.000Z"
    }];

    expect(() => exportResearch({ outputDir: "/tmp/pcbuildsage-pending" })).toThrow(/Invalid registry research category "\.\.\/evil"/);
  });
});
