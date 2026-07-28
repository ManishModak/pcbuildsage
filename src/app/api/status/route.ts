import { existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DEFAULT_DB_PATH } from "../../../lib/db";
import { resolvePython } from "../_lib/python";
import { json, serverError } from "../_lib/responses";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const dbPath = path.resolve(DEFAULT_DB_PATH);
    const dbExists = existsSync(dbPath);
    
    let rowCounts: Array<{ countryCode: string; count: number; lastScraped: string | null }> = [];
    let lastScraped: string | null = null;
    
    if (dbExists) {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        rowCounts = db.prepare(`
          SELECT country_code AS countryCode, COUNT(*) AS count, MAX(last_scraped) AS lastScraped 
          FROM products 
          GROUP BY country_code
          ORDER BY country_code
        `).all() as Array<{ countryCode: string; count: number; lastScraped: string | null }>;
        
        const overall = db.prepare("SELECT MAX(last_scraped) AS lastScraped FROM products").get() as { lastScraped: string | null } | undefined;
        lastScraped = overall?.lastScraped ?? null;
      } finally {
        db.close();
      }
    }

    return json({
      database: {
        path: dbPath,
        exists: dbExists,
        rowCounts,
        lastScraped
      },
      python: await resolvePython()
    });
  } catch (error) {
    return serverError(error);
  }
}
