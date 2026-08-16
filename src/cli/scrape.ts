import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Palette } from "./theme";
import { STATUS_GLYPHS } from "./theme";
import { parseNdjsonChunk, parseTrailingNdjson, type ScrapeEvent } from "./ndjson";
import { resolveRunTermination, type RunOutcome, type ScrapeRunConfig, type TestProfileConfig } from "@/contracts/scrape";
import {
  buildScraperArgs as buildProcessScraperArgs,
  buildTestProfileArgs,
  filesystemScrapePaths,
  resolvePython,
  spawnPython
} from "@/lib/server/python-process";

export type { ScrapeRunConfig } from "@/contracts/scrape";
export { pythonCandidates, resolvePython } from "@/lib/server/python-process";

type ProfileJson = {
  sites?: Array<{
    site_name?: string;
    categories?: Record<string, { max_pages?: number }>;
  }>;
};

export function buildScraperArgs(config: ScrapeRunConfig): string[] {
  return buildProcessScraperArgs(config, filesystemScrapePaths);
}

export function estimateScrape(config: ScrapeRunConfig, cwd = process.cwd()): { jobs: number; pages: number; duration: string } {
  const profile = loadProfileJson(config.profile, cwd);
  const siteFilter = new Set(config.sites?.map((site) => site.toLowerCase()));
  const categoryFilter = new Set(config.categories);
  let jobs = 0;
  let pages = 0;

  for (const site of profile.sites ?? []) {
    if (siteFilter.size && (!site.site_name || !siteFilter.has(site.site_name.toLowerCase()))) continue;
    for (const [category, data] of Object.entries(site.categories ?? {})) {
      if (categoryFilter.size && !categoryFilter.has(category)) continue;
      jobs += 1;
      const categoryPages = config.maxPages ?? (config.quick ? Math.min(2, data.max_pages ?? 2) : data.max_pages ?? 1);
      pages += Math.max(1, categoryPages);
    }
  }

  const seconds = Math.max(1, Math.round(pages * (2.5 + (config.delayMs ?? 1000) / 1000)));
  if (seconds < 60) {
    return { jobs, pages, duration: `~${seconds} sec` };
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return { jobs, pages, duration: `~${minutes} min` };
}

export async function runScraper(config: ScrapeRunConfig, palette: Palette, options: { json?: boolean } = {}): Promise<number> {
  const resolution = await resolvePython();
  if (!resolution.ok || !resolution.command) throw new Error(resolution.error ?? "Python interpreter is unavailable.");
  const args = buildScraperArgs(config);
  const estimate = estimateScrape(config);
  if (!options.json) console.log(`${STATUS_GLYPHS.unverified} estimated crawl time ${estimate.duration} (${estimate.jobs} jobs, ${estimate.pages} pages)`);
  const child = spawnPython(resolution, args);
  return renderScraper(child, palette, options);
}

export async function runTestProfile(config: TestProfileConfig): Promise<number> {
  const resolution = await resolvePython();
  if (!resolution.ok || !resolution.command) throw new Error(resolution.error ?? "Python interpreter is unavailable.");
  const child = spawnPython(resolution, buildTestProfileArgs(config), { stdio: "inherit" });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function renderScraper(child: ReturnType<typeof spawnPython>, palette: Palette, options: { json?: boolean }): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const outcomes: RunOutcome[] = [];
    if (!child.stdout || !child.stderr) {
      reject(new Error("Scraper process did not expose stdout/stderr."));
      return;
    }
    child.stdout.on("data", (chunk: Buffer) => {
      const parsed = parseNdjsonChunk(buffer, chunk.toString("utf8"));
      buffer = parsed.buffer;
      renderStreamEvents(parsed.events, outcomes, palette, options);
      for (const line of parsed.invalidLines) process.stderr.write(`Invalid scraper JSON: ${line}\n`);
    });
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const parsed = parseTrailingNdjson(buffer);
      renderStreamEvents(parsed.events, outcomes, palette, options);
      const termination = resolveCliTermination(outcomes, code);
      renderEvent({ type: "outcome", outcome: termination.outcome }, palette, options);
      resolve(termination.exitCode);
    });
  });
}

function renderStreamEvents(
  events: ScrapeEvent[],
  outcomes: RunOutcome[],
  palette: Palette,
  options: { json?: boolean }
): void {
  for (const event of events) {
    if (event.type === "outcome") outcomes.push(event.outcome);
    else renderEvent(event, palette, options);
  }
}

export function resolveCliTermination(
  outcomes: RunOutcome[],
  code: number | null
): { outcome: RunOutcome; exitCode: number } {
  const outcome = resolveRunTermination(outcomes, code, null);
  return {
    outcome,
    exitCode: outcome.status === "succeeded" ? 0 : code && code !== 0 ? code : 1
  };
}

function renderEvent(event: ScrapeEvent, palette: Palette, options: { json?: boolean }): void {
  if (options.json) {
    console.log(JSON.stringify(event));
    return;
  }
  if (event.type === "site_started") console.log(`${STATUS_GLYPHS.unverified} ${event.site}${event.category ? `/${event.category}` : ""} started`);
  if (event.type === "progress") {
    const percent = Math.max(0, Math.min(100, event.percent ?? 0));
    const filled = Math.round(percent / 5);
    const bar = `${"#".repeat(filled)}${"-".repeat(20 - filled)}`;
    const count = event.products_seen === undefined ? "" : ` ${event.products_seen} items`;
    console.log(`${palette.accent(bar)} ${String(percent).padStart(3)}% ${event.site}${event.category ? `/${event.category}` : ""}${count}${event.skipped ? " skipped" : ""}`);
  }
  if (event.type === "site_failed") console.log(palette.warn(`${STATUS_GLYPHS.warn} ${event.site}${event.category ? `/${event.category}` : ""}: ${event.error}`));
  if (event.type === "outcome") {
    const { outcome } = event;
    const count = outcome.products_written === null ? "" : ` (${outcome.products_written} products written)`;
    const message = `scrape ${outcome.status}${count}`;
    console.log(outcome.status === "succeeded" ? palette.ok(`${STATUS_GLYPHS.ok} ${message}`) : palette.warn(`${STATUS_GLYPHS.warn} ${message}`));
  }
  if (event.type === "error") console.log(palette.blocking(`${STATUS_GLYPHS.blocking} ${event.error}`));
}

function loadProfileJson(profile: string, cwd: string): ProfileJson {
  const candidates = [
    path.resolve(cwd, profile),
    path.resolve(cwd, "data", "profiles", profile.endsWith(".json") ? profile : `${profile}.json`)
  ];
  const filePath = candidates.find((candidate) => existsSync(candidate));
  if (!filePath) throw new Error(`Profile not found: ${profile}`);
  return JSON.parse(readFileSync(filePath, "utf8")) as ProfileJson;
}
