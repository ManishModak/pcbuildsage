import { existsSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { SqliteCatalogRepository } from "@/lib/catalog/sqlite-repository";
import { SampleConversation } from "../sample-conversation";
import fixture from "../../../../data/fixtures/sample-conversation.json";

interface SampleFixture {
  generated_at: string;
  source: { scope: { countryCode: string; currency: string } };
  snapshot: { components: Array<{ product_id?: string; price: number | null }> };
}

const fixtureData: SampleFixture = fixture as unknown as SampleFixture;

function resolveCatalogDb(): string {
  // The catalog the fixture was built from, recorded by the fixture script.
  // A gitignored local data/products.db may exist with arbitrary content, so
  // the recorded source wins over the existence-based fallback order.
  const recorded = (fixtureData.source as { db?: unknown } | undefined)?.db;
  if (typeof recorded === "string" && recorded.length > 0) {
    const recordedPath = path.isAbsolute(recorded) ? recorded : path.join(process.cwd(), recorded);
    if (existsSync(recordedPath)) return recordedPath;
  }
  const candidates = [
    process.env.PCBUILDSAGE_DB_PATH,
    path.join(process.cwd(), "data", "products.db"),
    path.join(process.cwd(), "data", "fixtures", "products-sample.db"),
    path.join(process.cwd(), "data", "products-sample.db")
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`No catalog database found. Tried: ${candidates.join(", ")}`);
  return found;
}

describe("sample conversation", () => {
  const dbPath = resolveCatalogDb();
  const repo = new SqliteCatalogRepository(dbPath);
  afterAll(async () => {
    await repo.close?.();
  });

  it("references only product IDs that exist in the catalog", async () => {
    const ids = fixtureData.snapshot.components
      .map((component) => component.product_id)
      .filter((id): id is string => Boolean(id));
    expect(ids.length).toBeGreaterThan(0);

    const scope = {
      countryCode: fixtureData.source.scope.countryCode,
      currency: fixtureData.source.scope.currency
    };
    const resolved = await repo.searchProducts(
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
      expect(markup).toContain("Intel Core i9-14900K Desktop Processor");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
