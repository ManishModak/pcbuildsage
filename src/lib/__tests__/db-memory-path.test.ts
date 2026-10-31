import { afterEach, describe, expect, it } from "vitest";
import { closeDb, getDb, getLogsDb } from "../db";
import { resolveConfig } from "../config";

describe("in-memory database paths", () => {
  afterEach(() => closeDb());

  it('keeps ":memory:" in memory instead of creating a file named ":memory:"', () => {
    expect(getDb(":memory:").memory).toBe(true);
    expect(getLogsDb(":memory:").memory).toBe(true);
    expect(resolveConfig({ dbPath: ":memory:" }).dbPath).toBe(":memory:");
  });
});
