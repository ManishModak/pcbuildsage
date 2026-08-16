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

import { getLogsDb, writeDbLog, closeDb, MAX_LOG_DETAILS_BYTES, serializeLogDetails } from "../db";

describe("db logs", () => {
  beforeEach(() => {
    closeDb();
  });

  it("initializes logs.db with only logs table", () => {
    const db = getLogsDb();
    
    // Check logs table exists
    const logsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='logs'").get();
    expect(logsTable).toBeDefined();
    expect(logsTable).not.toBeNull();

    // Check products table DOES NOT exist (no catalog leak!)
    const productsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='products'").get();
    expect(productsTable).toBeUndefined();
  });

  it("writes logs to db log table", () => {
    const db = getLogsDb();
    writeDbLog(undefined, "INFO", "test-component", "test message", { foo: "bar" });

    const logs = db.prepare("SELECT * FROM logs ORDER BY id DESC").all() as Array<{
      id: number;
      timestamp: string;
      level: string;
      component: string;
      message: string;
      details: string;
    }>;
    expect(logs.length).toBe(1);
    expect(logs[0].level).toBe("INFO");
    expect(logs[0].component).toBe("test-component");
    expect(logs[0].message).toBe("test message");
    expect(JSON.parse(logs[0].details)).toEqual({ foo: "bar" });
  });

  it("redacts secrets and replaces oversized details with bounded metadata", () => {
    expect(JSON.parse(serializeLogDetails({ apiKey: "secret", key: "standalone-key", privateKey: "pem-data", nested: { authorization: "Bearer token" } }))).toEqual({
      apiKey: "[redacted]",
      key: "[redacted]",
      privateKey: "[redacted]",
      nested: { authorization: "[redacted]" }
    });
    const oversized = serializeLogDetails({ payload: "x".repeat(MAX_LOG_DETAILS_BYTES * 2) });
    expect(Buffer.byteLength(oversized, "utf8")).toBeLessThanOrEqual(MAX_LOG_DETAILS_BYTES);
    expect(JSON.parse(oversized)).toMatchObject({ truncated: true });
  });
});
