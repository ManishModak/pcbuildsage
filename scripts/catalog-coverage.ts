#!/usr/bin/env tsx
/**
 * scripts/catalog-coverage.ts
 *
 * Reports which retailers and categories a catalog refresh updated, which
 * failed and why, and how many in-stock listings each has. The hosted refresh
 * (.github/workflows/refresh-catalog.yml) runs it after publish-catalog: the
 * markdown goes to the job summary, and to a tracking issue while any scope
 * has gone stale.
 *
 * Usage: npm run catalog-coverage -- --db <candidate.db> [--profile india] [--exclude-sites A,B]
 *        [--json <file>] [--markdown <file>]
 *
 * Scrape outcomes come from the candidate DB's scrape_jobs table. With
 * --profile, every site and category the profile lists (minus --exclude-sites)
 * is expected, so one the scraper never reached shows as not run. Listing
 * counts come from Turso when TURSO_DATABASE_URL and a token are set (the
 * hosted catalog after publish, including listings preserved from earlier
 * runs), otherwise from the candidate DB itself.
 */

import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createClient } from "@libsql/client";

export type JobStatus = "complete" | "partial" | "failed";

export interface ScrapeJob {
  retailer: string;
  category: string;
  status: JobStatus;
  error: string | null;
}

export interface Scope {
  retailer: string;
  category: string;
}

export interface ListingCounts {
  retailer: string;
  category: string;
  inStock: number;
  /** Newest last_scraped of any listing in the scope, in stock or not. */
  lastScraped: string | null;
}

export interface ScopeCoverage {
  category: string;
  job: JobStatus | "not run";
  reason: string | null;
  inStock: number;
  lastScraped: string | null;
  /** No listing in this scope was refreshed within staleAfterHours. */
  stale: boolean;
}

export interface RetailerCoverage {
  retailer: string;
  inStock: number;
  lastScraped: string | null;
  scopes: ScopeCoverage[];
}

export interface CoverageReport {
  generatedAt: string;
  staleAfterHours: number;
  retailers: RetailerCoverage[];
  categories: string[];
  /** "Retailer/category" for every stale scope; non-empty means someone should look. */
  stale: string[];
}

export const DEFAULT_STALE_AFTER_HOURS = 24;

/** Short, groupable reason: drops the "Retailer: " prefix, URLs and anything past 120 chars. */
export function shortReason(retailer: string, error: string | null): string | null {
  if (!error) return null;
  let text = error.replace(/\s+/g, " ").trim();
  if (text.startsWith(`${retailer}: `)) text = text.slice(retailer.length + 2);
  text = text.replace(/\s*(?:for |at )?https?:\/\/\S+/g, "").trim();
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

/**
 * Joins this run's scrape outcomes with listing counts. A scope appears if it
 * is expected, this run scraped it, or it still has in-stock listings.
 */
export function buildCoverageReport(
  jobs: ScrapeJob[],
  counts: ListingCounts[],
  now: Date,
  { staleAfterHours = DEFAULT_STALE_AFTER_HOURS, expected = [] }: { staleAfterHours?: number; expected?: Scope[] } = {}
): CoverageReport {
  const cutoff = now.getTime() - staleAfterHours * 3_600_000;
  const key = (retailer: string, category: string) => `${retailer}\u0000${category}`;
  const jobByScope = new Map(jobs.map((job) => [key(job.retailer, job.category), job]));
  const countByScope = new Map(counts.map((count) => [key(count.retailer, count.category), count]));

  const scopeKeys = new Set<string>([
    ...expected.map((scope) => key(scope.retailer, scope.category)),
    ...jobs.map((job) => key(job.retailer, job.category)),
    ...counts.filter((count) => count.inStock > 0).map((count) => key(count.retailer, count.category))
  ]);

  const byRetailer = new Map<string, ScopeCoverage[]>();
  for (const scopeKey of scopeKeys) {
    const [retailer, category] = scopeKey.split("\u0000");
    const job = jobByScope.get(scopeKey);
    const count = countByScope.get(scopeKey);
    const lastScraped = count?.lastScraped ?? null;
    const scopes = byRetailer.get(retailer) ?? [];
    scopes.push({
      category,
      job: job?.status ?? "not run",
      reason: job ? shortReason(retailer, job.error) : null,
      inStock: count?.inStock ?? 0,
      lastScraped,
      stale: !lastScraped || !(Date.parse(lastScraped) >= cutoff)
    });
    byRetailer.set(retailer, scopes);
  }

  const retailers: RetailerCoverage[] = [...byRetailer.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([retailer, scopes]) => {
      scopes.sort((a, b) => a.category.localeCompare(b.category));
      const dates = scopes.map((s) => s.lastScraped).filter((d): d is string => Boolean(d));
      return {
        retailer,
        inStock: scopes.reduce((sum, s) => sum + s.inStock, 0),
        lastScraped: dates.length > 0 ? dates.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null,
        scopes
      };
    });

  return {
    generatedAt: now.toISOString(),
    staleAfterHours,
    retailers,
    categories: [...new Set(retailers.flatMap((r) => r.scopes.map((s) => s.category)))].sort(),
    stale: retailers.flatMap((r) => r.scopes.filter((s) => s.stale).map((s) => `${r.retailer}/${s.category}`))
  };
}

function formatAge(iso: string | null, now: Date): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return "never";
  const hours = Math.max(0, (now.getTime() - Date.parse(iso)) / 3_600_000);
  if (hours < 1) return "under 1 h ago";
  if (hours < 48) return `${Math.floor(hours)} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

const MARK: Record<ScopeCoverage["job"], string> = {
  complete: "",
  partial: " ⚠️",
  failed: " ❌",
  "not run": " ⏸"
};

/** One line per (job status, reason) group, e.g. "❌ cpu, gpu: http 403". */
function problemLines(retailer: RetailerCoverage): string[] {
  const groups = new Map<string, { icon: string; text: string; categories: string[] }>();
  for (const scope of retailer.scopes) {
    if (scope.job === "complete" && !scope.stale) continue;
    const [icon, text] =
      scope.job === "complete"
        ? ["🕸", "no fresh listings"]
        : scope.job === "not run"
          ? ["⏸", "not scraped this run"]
          : [MARK[scope.job].trim(), scope.reason ?? `${scope.job}, no reason recorded`];
    const group = groups.get(`${icon} ${text}`) ?? { icon, text, categories: [] };
    group.categories.push(scope.category);
    groups.set(`${icon} ${text}`, group);
  }
  return [...groups.values()].map(({ icon, text, categories }) => {
    const which =
      categories.length === retailer.scopes.length && categories.length > 1
        ? `all ${categories.length} categories`
        : categories.join(", ");
    return `${icon} ${which}: ${text}`;
  });
}

const escapeCell = (text: string) => text.replace(/\|/g, "\\|");

/** Markdown for the job summary and the tracking issue. */
export function renderMarkdown(report: CoverageReport, runUrl?: string): string {
  const now = new Date(report.generatedAt);
  const lines: string[] = [];
  lines.push("## Catalog coverage", "");
  lines.push(
    `Checked ${report.generatedAt.slice(0, 16).replace("T", " ")} UTC${runUrl ? ` in [this run](${runUrl})` : ""}.`
  );
  if (report.stale.length > 0) {
    lines.push(
      "",
      `**No fresh listings for ${report.staleAfterHours} h or more:** ${report.stale.join(", ")}.`
    );
  } else {
    lines.push("", `Every scope has listings refreshed within ${report.staleAfterHours} h.`);
  }

  lines.push("", "| Retailer | In stock | Newest listing | Problems |", "|---|---:|---|---|");
  for (const retailer of report.retailers) {
    const problems = problemLines(retailer);
    lines.push(
      `| ${escapeCell(retailer.retailer)} | ${retailer.inStock.toLocaleString("en-US")} | ${formatAge(retailer.lastScraped, now)} | ${problems.length > 0 ? escapeCell(problems.join("<br>")) : "—"} |`
    );
  }

  lines.push("", "In-stock listings by category (⚠️ partial crawl, ❌ failed, ⏸ not scraped this run):", "");
  lines.push(
    `| Category | ${report.retailers.map((r) => escapeCell(r.retailer)).join(" | ")} | Total |`,
    `|---|${report.retailers.map(() => "---:").join("|")}|---:|`
  );
  for (const category of report.categories) {
    let total = 0;
    const cells = report.retailers.map((retailer) => {
      const scope = retailer.scopes.find((s) => s.category === category);
      if (!scope) return "";
      total += scope.inStock;
      return `${scope.inStock.toLocaleString("en-US")}${MARK[scope.job]}`;
    });
    lines.push(`| ${escapeCell(category)} | ${cells.join(" | ")} | ${total.toLocaleString("en-US")} |`);
  }
  return `${lines.join("\n")}\n`;
}

/** This run's outcomes; an old DB without scrape_jobs reports none. */
export function readScrapeJobs(db: Database.Database): ScrapeJob[] {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scrape_jobs'")
    .get();
  if (!table) return [];
  return db
    .prepare("SELECT retailer, category, status, error FROM scrape_jobs")
    .all() as ScrapeJob[];
}

const COUNTS_SQL = `
  SELECT retailer, category,
         SUM(CASE WHEN in_stock = 1 THEN 1 ELSE 0 END) AS in_stock,
         MAX(last_scraped) AS last_scraped
  FROM products`;

function countsQuery(countries: string[]): { sql: string; args: string[] } {
  const where = countries.length > 0 ? ` WHERE country_code IN (${countries.map(() => "?").join(", ")})` : "";
  return { sql: `${COUNTS_SQL}${where} GROUP BY retailer, category`, args: countries };
}

function toCounts(rows: Array<Record<string, unknown>>): ListingCounts[] {
  return rows.map((row) => ({
    retailer: String(row.retailer),
    category: String(row.category),
    inStock: Number(row.in_stock ?? 0),
    lastScraped: row.last_scraped == null ? null : String(row.last_scraped)
  }));
}

function tursoEnv(): { url: string; token: string } | null {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const token = (process.env.TURSO_INGEST_TOKEN ?? process.env.TURSO_AUTH_TOKEN)?.trim();
  return url && token ? { url, token } : null;
}

async function readCounts(db: Database.Database | null, countries: string[]): Promise<ListingCounts[]> {
  const turso = tursoEnv();
  const query = countsQuery(countries);
  if (!turso) {
    if (!db) throw new Error("no candidate DB and no Turso to count listings from");
    return toCounts(db.prepare(query.sql).all(...query.args) as Array<Record<string, unknown>>);
  }
  const client = createClient({ url: turso.url, authToken: turso.token });
  try {
    const result = await client.execute(query);
    return toCounts(result.rows as unknown as Array<Record<string, unknown>>);
  } finally {
    client.close();
  }
}

interface Profile {
  country_code: string;
  sites: Array<{ site_name: string; categories: Record<string, unknown> }>;
}

/** Reads data/profiles/<name>.json (or a path), like the scraper's --profile. */
function readProfile(profile: string): Profile {
  const file = fs.existsSync(profile)
    ? profile
    : path.join(process.cwd(), "data", "profiles", profile.endsWith(".json") ? profile : `${profile}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as Profile;
}

/** The scopes a scrape of `profile` minus `excludeSites` should record. */
export function expectedScopes(profile: Profile, excludeSites: string[]): Scope[] {
  const excluded = new Set(excludeSites.map((name) => name.trim().toLowerCase()));
  return profile.sites
    .filter((site) => !excluded.has(site.site_name.toLowerCase()))
    .flatMap((site) => Object.keys(site.categories).map((category) => ({ retailer: site.site_name, category })));
}

export async function runCatalogCoverage(args: string[] = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: "string" },
      json: { type: "string" },
      markdown: { type: "string" },
      profile: { type: "string" },
      "exclude-sites": { type: "string" },
      "stale-after-hours": { type: "string" }
    },
    strict: true
  });
  const dbPath = values.db ?? process.env.PCBUILDSAGE_DB_PATH ?? path.join(process.cwd(), "data", "products.db");
  const hasDb = fs.existsSync(dbPath);
  // A scrape that crashed before creating the DB still gets a report from Turso.
  if (!hasDb && !(values.profile && tursoEnv())) {
    console.error(`[catalog-coverage] Candidate database not found: ${dbPath}`);
    return 1;
  }
  const profile = values.profile ? readProfile(values.profile) : null;
  const expected = profile ? expectedScopes(profile, (values["exclude-sites"] ?? "").split(",").filter(Boolean)) : [];
  const staleAfterHours = Number(values["stale-after-hours"] ?? DEFAULT_STALE_AFTER_HOURS);
  if (!Number.isFinite(staleAfterHours) || staleAfterHours <= 0) {
    console.error(`[catalog-coverage] Invalid --stale-after-hours: ${values["stale-after-hours"]}`);
    return 1;
  }

  const db = hasDb ? new Database(dbPath, { readonly: true, fileMustExist: true }) : null;
  let report: CoverageReport;
  try {
    const jobs = db ? readScrapeJobs(db) : [];
    const countries = profile
      ? [profile.country_code]
      : db && jobs.length > 0
        ? (db.prepare("SELECT DISTINCT country_code FROM scrape_jobs").pluck().all() as string[])
        : [];
    report = buildCoverageReport(jobs, await readCounts(db, countries), new Date(), { staleAfterHours, expected });
  } finally {
    db?.close();
  }

  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;
  const markdown = renderMarkdown(report, runUrl);
  if (values.json) fs.writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
  if (values.markdown) fs.writeFileSync(values.markdown, markdown);
  if (!values.json && !values.markdown) process.stdout.write(markdown);
  return 0;
}

const isMain = Boolean(
  process.argv[1] &&
    (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
      process.argv[1].endsWith("catalog-coverage.ts"))
);

if (isMain) {
  runCatalogCoverage()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("[catalog-coverage] Uncaught error:", err);
      process.exit(1);
    });
}
