import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initializeSchema } from "@/lib/db";
import { SqliteCatalogRepository } from "@/lib/catalog/sqlite-repository";
import { searchProducts, createSearchProductsTool } from "../search-products";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

describe("search hints and errors", () => {
  let db: Database.Database;
  let repo: SqliteCatalogRepository;

  beforeEach(() => {
    db = createDb();
    repo = new SqliteCatalogRepository(db);
  });

  afterEach(async () => {
    await repo.close();
  });

  it("empty term match says so and suggests list_models", async () => {
    const out = await searchProducts(
      { term: "no-such-part-xyz" },
      { countryCode: "US", currency: "USD" },
      repo
    );
    expect(out.results).toHaveLength(0);
    expect(out.hint).toMatch(/No products match.*no-such-part-xyz/i);
    expect(out.hint).toMatch(/list_models/i);
  });

  it("invalid-input errors are one line listing valid filters", async () => {
    const out = await searchProducts(
      { category: "cpu", max_length_mm: 300 } as never,
      { countryCode: "US", currency: "USD" },
      repo
    );
    expect(out.error).toContain("max_length_mm");
    expect(out.error).toContain("Valid filters:");
    expect(out.error).not.toContain("\n");
  });

  it("description has no duplicated filter list and no local SQLite wording", () => {
    const tool = createSearchProductsTool({ countryCode: "US", currency: "USD" });
    const desc = typeof tool.description === "string" ? tool.description : "";
    expect(desc).not.toMatch(/local SQLite database/i);
    expect(desc).not.toMatch(/Filterable fields:/);
  });
});
