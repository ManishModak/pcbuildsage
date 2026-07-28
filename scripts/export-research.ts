import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getDb } from "../src/lib/db";
import type { RegistryResearchEntry } from "../src/lib/db-types";

const db = getDb();
try {
  const rows = db.prepare("SELECT * FROM registry_research ORDER BY category, key").all() as RegistryResearchEntry[];
  const byCategory = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    const categoryEntries = byCategory.get(row.category) ?? { $schema: "../../schemas/registry.schema.json" };
    categoryEntries[row.key] = {
      ...JSON.parse(row.specs),
      sources: row.sources ? JSON.parse(row.sources) : [],
      confidence: row.confidence,
      researched_at: row.researched_at
    };
    byCategory.set(row.category, categoryEntries);
  }

  const outputDir = path.join(process.cwd(), "data", "registry", "pending");
  mkdirSync(outputDir, { recursive: true });

  for (const [category, entries] of byCategory) {
    writeFileSync(path.join(outputDir, `${category}.json`), `${JSON.stringify(entries, null, 2)}\n`);
  }

  console.log(`Exported ${rows.length} researched registry entries to ${outputDir}`);
} finally {
  db.close();
}
