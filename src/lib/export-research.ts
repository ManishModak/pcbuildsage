import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/db";
import type { RegistryResearchEntry } from "@/types";

export function exportResearch(options: { dbPath?: string; outputDir?: string } = {}) {
  const db = getDb(options.dbPath);
  const outputDir = options.outputDir ?? path.join(process.cwd(), "data", "registry", "pending");
  const rows = db.prepare("SELECT key, category, specs, sources, confidence, researched_at FROM registry_research ORDER BY category, key").all() as RegistryResearchEntry[];
  const grouped = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const specs = JSON.parse(row.specs) as Record<string, unknown>;
    const category = row.category;
    if (!/^[a-z0-9_-]+$/i.test(category)) {
      throw new Error(`Invalid registry research category "${category}".`);
    }
    const bucket = grouped.get(category) ?? { $schema: "../../schemas/registry.schema.json" };
    bucket[row.key] = {
      ...specs,
      sources: JSON.parse(row.sources ?? "[]"),
      confidence: row.confidence,
      researched_at: row.researched_at
    };
    grouped.set(category, bucket);
  }
  mkdirSync(outputDir, { recursive: true });
  const written: string[] = [];
  for (const [category, data] of grouped) {
    const filePath = path.join(outputDir, `${category}.json`);
    writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    written.push(filePath);
  }
  return written;
}
