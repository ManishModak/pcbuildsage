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
    const rowCounts = dbExists ? countRowsByCountry(dbPath) : [];
    return json({
      database: {
        path: dbPath,
        exists: dbExists,
        rowCounts
      },
      python: await resolvePython()
    });
  } catch (error) {
    return serverError(error);
  }
}

function countRowsByCountry(dbPath: string) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT country_code AS countryCode, COUNT(*) AS count FROM products GROUP BY country_code ORDER BY country_code").all();
  } finally {
    db.close();
  }
}
