import { existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DEFAULT_DB_PATH } from "../../../lib/db";
import { getDeploymentMode } from "@/lib/config/deployment";
import { getCatalogRepository } from "@/lib/catalog";
import { resolvePython } from "@/lib/server/python-process";
import { json, serverError } from "../_lib/responses";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const mode = getDeploymentMode();
    const isHosted = mode === "hosted-demo";

    if (isHosted) {
      let lastScraped: string | null = null;
      let productCount = 0;
      let rowCounts: Array<{ countryCode: string; count: number; lastScraped?: string | null }> = [];
      let exists = false;

      try {
        const repo = getCatalogRepository();
        const freshness = await repo.getFreshness();
        lastScraped = freshness.lastScraped ?? null;
        productCount = freshness.productCount ?? 0;
        rowCounts = (freshness.rowCounts ?? []) as Array<{ countryCode: string; count: number; lastScraped?: string | null }>;
        exists = true;
      } catch {
        // In hosted-demo mode, if remote repository is unconfigured or unreachable,
        // provide safe fallback values without leaking local paths.
        exists = false;
      }

      return json({
        status: "ok",
        mode: "hosted-demo",
        deploymentMode: "hosted-demo",
        catalogFreshness: lastScraped,
        productCount,
        database: {
          exists,
          rowCounts,
          lastScraped
        }
      });
    }

    const dbPath = path.resolve(DEFAULT_DB_PATH);
    const dbExists = existsSync(dbPath);

    let rowCounts: Array<{ countryCode: string; count: number; lastScraped: string | null }> = [];
    let lastScraped: string | null = null;
    
    if (dbExists) {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='products'").get();
        if (tableExists) {
          rowCounts = db.prepare(`
            SELECT country_code AS countryCode, COUNT(*) AS count, MAX(last_scraped) AS lastScraped
            FROM products
            GROUP BY country_code
            ORDER BY country_code
          `).all() as Array<{ countryCode: string; count: number; lastScraped: string | null }>;

          const overall = db.prepare("SELECT MAX(last_scraped) AS lastScraped FROM products").get() as { lastScraped: string | null } | undefined;
          lastScraped = overall?.lastScraped ?? null;
        }
      } catch {
        rowCounts = [];
        lastScraped = null;
      } finally {
        db.close();
      }
    }


    return json({
      status: "ok",
      mode: "local",
      deploymentMode: "local",
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

