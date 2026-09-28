import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { SqliteCatalogRepository } from "@/lib/catalog/sqlite-repository";
import { SampleConversation } from "../sample-conversation";
import fixture from "../../../../data/fixtures/sample-conversation.json";

interface SampleFixture {
  generated_at: string;
  source: { db: string; scope: { countryCode: string; currency: string } };
  snapshot: { components: Array<{ name: string; product_id?: string; price: number | null }> };
}

const fixtureData: SampleFixture = fixture as unknown as SampleFixture;

// The fixture must come from the real scraped catalog. That database is
// gitignored, so CI can't check membership; dev machines with it do. The
// 12-row products-sample.db never counts: an example built from test data
// would show parts nobody can buy.
const realCatalogDb = [process.env.PCBUILDSAGE_DB_PATH, path.join(process.cwd(), "data", "products.db")]
  .filter((candidate): candidate is string => Boolean(candidate))
  .find((candidate) => existsSync(candidate) && hasProducts(candidate));

function hasProducts(dbPath: string): boolean {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return (db.prepare("SELECT COUNT(*) AS n FROM products").get() as { n: number }).n > 0;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

describe("sample conversation", () => {
  const repo = realCatalogDb ? new SqliteCatalogRepository(realCatalogDb) : null;
  afterAll(async () => {
    await repo?.close?.();
  });

  it("was not built from the test-only sample database", () => {
    expect(fixtureData.source.db).not.toMatch(/products-sample/);
  });

  it.skipIf(!repo)("references only product IDs that exist in the real catalog", async () => {
    const ids = fixtureData.snapshot.components
      .map((component) => component.product_id)
      .filter((id): id is string => Boolean(id));
    expect(ids.length).toBeGreaterThan(0);

    const scope = {
      countryCode: fixtureData.source.scope.countryCode,
      currency: fixtureData.source.scope.currency
    };
    const resolved = await repo!.searchProducts(
      { product_ids: ids, inStockOnly: false, limit: ids.length },
      scope
    );
    const found = new Set(resolved.results.map((product) => product.id));
    expect(ids.filter((id) => !found.has(id))).toEqual([]);
    // Every example part is priced, so the card shows an honest total.
    expect(
      fixtureData.snapshot.components.every((component) => component.price !== null)
    ).toBe(true);
  });

  it("renders the example statically, labelled, with no network calls", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const markup = renderToStaticMarkup(<SampleConversation currency="INR" />);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(markup).toContain("Example");
      expect(markup).toContain("not your chat");
      expect(markup).toContain(fixtureData.generated_at.slice(0, 10));
      expect(markup).toContain("Nothing here was saved");
      // The real build card rendered from the snapshot.
      expect(markup).toContain("Proposed build");
      expect(markup).toContain(fixtureData.snapshot.components[0].name);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
