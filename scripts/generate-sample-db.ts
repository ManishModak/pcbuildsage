import { readFileSync } from "node:fs";
import path from "node:path";
import { closeDb, getDb } from "../src/lib/db";

function main() {
  const dbPath = process.argv[2] || path.join(process.cwd(), "data", "products-sample.db");
  console.log(`Generating tiny sample database at ${dbPath}...`);

  // getDb creates the directory, applies pragmas, and initializes the schema.
  const db = getDb(dbPath);

  const fixturePath = path.join(process.cwd(), "data", "fixtures", "products-fixture.json");
  const products = JSON.parse(readFileSync(fixturePath, "utf8"));

  const insert = db.prepare(`
    INSERT OR REPLACE INTO products (
      id, name, normalized_name, registry_key, price, currency,
      country_code, retailer, url, image_url, in_stock, category, subcategory, specs,
      first_seen, last_scraped
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transaction = db.transaction((items: any[]) => {
    for (const item of items) {
      const price = item.price ?? (typeof item.price_minor === "number" ? item.price_minor / 100 : null);
      insert.run(
        item.id,
        item.name,
        item.normalized_name,
        item.registry_key,
        price,
        item.currency,
        item.country_code,
        item.retailer,
        item.url,
        item.image_url,
        item.in_stock,
        item.category,
        item.subcategory ?? null,
        item.specs ? JSON.stringify(item.specs) : null,
        item.first_seen,
        item.last_scraped
      );
    }
  });

  transaction(products);

  closeDb(dbPath);
  console.log("Sample database generated successfully.");
}

main();
