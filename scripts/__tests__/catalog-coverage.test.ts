import { describe, it, expect, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCoverageReport,
  renderMarkdown,
  runCatalogCoverage,
  shortReason,
  type ListingCounts,
  type ScrapeJob
} from "../catalog-coverage";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe("shortReason", () => {
  it("drops the retailer prefix and URLs so categories with the same failure group together", () => {
    expect(
      shortReason("EliteHubs", "EliteHubs: both browser and http engines failed validation for https://elitehubs.com/collections/ram")
    ).toBe("both browser and http engines failed validation");
    expect(shortReason("X", null)).toBeNull();
  });
});

describe("buildCoverageReport", () => {
  it("flags only scopes with no listing refreshed within the window", () => {
    const jobs: ScrapeJob[] = [
      { retailer: "Shop", category: "cpu", status: "complete", error: null },
      { retailer: "Shop", category: "gpu", status: "failed", error: "Shop: http 403" },
      { retailer: "Shop", category: "ram", status: "failed", error: "Shop: http 403" },
      { retailer: "Shop", category: "psu", status: "complete", error: null }
    ];
    const counts: ListingCounts[] = [
      { retailer: "Shop", category: "cpu", inStock: 10, lastScraped: hoursAgo(1) },
      // Failed this run, but an earlier run refreshed it 12 h ago: not stale yet.
      { retailer: "Shop", category: "gpu", inStock: 5, lastScraped: hoursAgo(12) },
      { retailer: "Shop", category: "ram", inStock: 0, lastScraped: hoursAgo(30) }
      // psu: "complete" but no listings at all.
    ];
    const report = buildCoverageReport(jobs, counts, NOW);
    expect(report.stale).toEqual(["Shop/psu", "Shop/ram"]);
    expect(report.retailers[0].inStock).toBe(15);
    expect(report.retailers[0].lastScraped).toBe(hoursAgo(1));
  });

  it("lists unscraped retailers only while they still have in-stock listings", () => {
    const counts: ListingCounts[] = [
      { retailer: "Retired", category: "cpu", inStock: 0, lastScraped: hoursAgo(700) },
      { retailer: "Skipped", category: "cpu", inStock: 3, lastScraped: hoursAgo(50) }
    ];
    const report = buildCoverageReport([], counts, NOW);
    expect(report.retailers.map((r) => r.retailer)).toEqual(["Skipped"]);
    expect(report.retailers[0].scopes[0].job).toBe("not run");
    expect(report.stale).toEqual(["Skipped/cpu"]);
  });
});

describe("renderMarkdown", () => {
  it("groups a retailer's failures by reason and marks each category cell", () => {
    const jobs: ScrapeJob[] = ["cpu", "gpu"].map((category) => ({
      retailer: "Down",
      category,
      status: "failed" as const,
      error: `Down: blocked for https://down.example/${category}`
    }));
    jobs.push({ retailer: "Up", category: "cpu", status: "partial", error: "partial crawl (page limit)" });
    const counts: ListingCounts[] = [{ retailer: "Up", category: "cpu", inStock: 1200, lastScraped: hoursAgo(2) }];
    const markdown = renderMarkdown(buildCoverageReport(jobs, counts, NOW));
    expect(markdown).toContain("**No fresh listings for 24 h or more:** Down/cpu, Down/gpu.");
    expect(markdown).toContain("| Down | 0 | never | ❌ all 2 categories: blocked |");
    expect(markdown).toContain("| Up | 1,200 | 2 h ago | ⚠️ cpu: partial crawl (page limit) |");
    expect(markdown).toContain("| cpu | 0 ❌ | 1,200 ⚠️ | 1,200 |");
  });
});

describe("runCatalogCoverage", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function candidateDb(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-coverage-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "catalog.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE products (id TEXT PRIMARY KEY, retailer TEXT, category TEXT, country_code TEXT,
                             in_stock INTEGER, last_scraped TEXT);
      CREATE TABLE scrape_jobs (country_code TEXT, retailer TEXT, category TEXT, status TEXT,
                                finished_at TEXT, error TEXT);
    `);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO products VALUES (?, ?, ?, ?, ?, ?)").run("a", "Up", "cpu", "IN", 1, now);
    db.prepare("INSERT INTO products VALUES (?, ?, ?, ?, ?, ?)").run("b", "Up", "cpu", "IN", 0, now);
    db.prepare("INSERT INTO products VALUES (?, ?, ?, ?, ?, ?)").run("c", "Other", "cpu", "US", 1, now);
    db.prepare("INSERT INTO scrape_jobs VALUES (?, ?, ?, ?, ?, ?)").run("IN", "Up", "cpu", "complete", now, null);
    db.prepare("INSERT INTO scrape_jobs VALUES (?, ?, ?, ?, ?, ?)").run("IN", "Down", "gpu", "failed", now, "Down: 403");
    db.close();
    return dbPath;
  }

  // The libsql client accepts file: URLs, so this exercises the same query path CI runs against Turso.
  it.each([
    ["the candidate DB", {}],
    ["a libsql client", { TURSO_DATABASE_URL: "file:CANDIDATE", TURSO_INGEST_TOKEN: "unused" }]
  ])("writes JSON and markdown counted from %s, limited to the scraped countries", async (_label, env) => {
    const dbPath = candidateDb();
    vi.stubEnv("TURSO_DATABASE_URL", "");
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value.replace("CANDIDATE", dbPath));
    const out = path.dirname(dbPath);

    const code = await runCatalogCoverage([
      "--db", dbPath, "--json", path.join(out, "coverage.json"), "--markdown", path.join(out, "coverage.md")
    ]);

    expect(code).toBe(0);
    const report = JSON.parse(fs.readFileSync(path.join(out, "coverage.json"), "utf8"));
    expect(report.retailers.map((r: { retailer: string; inStock: number }) => [r.retailer, r.inStock])).toEqual([
      ["Down", 0],
      ["Up", 1]
    ]);
    expect(report.stale).toEqual(["Down/gpu"]);
    expect(fs.readFileSync(path.join(out, "coverage.md"), "utf8")).toContain("| Down | 0 | never | ❌ gpu: 403 |");
  });

  it("fails when the candidate DB is missing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runCatalogCoverage(["--db", path.join(os.tmpdir(), "no-such-catalog.db")])).toBe(1);
    error.mockRestore();
  });
});
