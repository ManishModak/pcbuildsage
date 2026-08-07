import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Palette } from "./theme";
import { STATUS_GLYPHS } from "./theme";
import { parseNdjsonChunk, parseTrailingNdjson, type ScrapeEvent } from "./ndjson";

export type PythonCandidate = {
  command: string;
  args: string[];
  label: string;
};

export type PythonResolution = {
  ok: boolean;
  command?: string;
  args: string[];
  label?: string;
  error?: string;
};

export type ScrapeRunConfig = {
  profile: string;
  sites?: string[];
  categories?: string[];
  quick?: boolean;
  maxPages?: number;
  skipFresh?: number;
  noLlmFallback?: boolean;
  maxLlmCalls?: number;
  concurrency?: number;
  delayMs?: number;
  headed?: boolean;
  db?: string;
};

type ProfileJson = {
  sites?: Array<{
    site_name?: string;
    categories?: Record<string, { max_pages?: number }>;
  }>;
};

export function pythonCandidates(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env, exists: (filePath: string) => boolean = existsSync): PythonCandidate[] {
  const candidates: PythonCandidate[] = [];
  if (env.PYTHON_PATH) candidates.push({ command: env.PYTHON_PATH, args: [], label: "PYTHON_PATH" });
  const windowsVenv = path.join(cwd, ".venv", "Scripts", "python.exe");
  const posixVenv = path.join(cwd, ".venv", "bin", "python");
  if (exists(windowsVenv)) candidates.push({ command: windowsVenv, args: [], label: ".venv/Scripts/python.exe" });
  if (exists(posixVenv)) candidates.push({ command: posixVenv, args: [], label: ".venv/bin/python" });
  candidates.push(
    { command: "py", args: ["-3"], label: "py -3" },
    { command: "python3", args: [], label: "python3" },
    { command: "python", args: [], label: "python" }
  );
  return candidates;
}

export async function resolvePython(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (filePath: string) => boolean;
  validate?: (candidate: PythonCandidate) => Promise<boolean>;
} = {}): Promise<PythonResolution> {
  const errors: string[] = [];
  for (const candidate of pythonCandidates(options.cwd, options.env, options.exists)) {
    try {
      if (await (options.validate ?? validatePython)(candidate)) {
        return { ok: true, command: candidate.command, args: candidate.args, label: candidate.label };
      }
      errors.push(`${candidate.label}: validation failed`);
    } catch (error) {
      errors.push(`${candidate.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ok: false, args: [], error: errors.join("; ") || "No Python interpreter found." };
}

export function buildScraperArgs(config: ScrapeRunConfig): string[] {
  const args = ["-m", "scraper", "--json-stdout", "--profile", config.profile];
  appendCsv(args, "--sites", config.sites);
  appendCsv(args, "--categories", config.categories);
  if (config.quick) args.push("--quick");
  appendNumber(args, "--max-pages", config.maxPages);
  appendNumber(args, "--skip-fresh", config.skipFresh);
  if (config.noLlmFallback) args.push("--no-llm-fallback");
  appendNumber(args, "--max-llm-calls", config.maxLlmCalls);
  appendNumber(args, "--concurrency", config.concurrency);
  appendNumber(args, "--delay-ms", config.delayMs);
  if (config.headed) args.push("--headed");
  if (config.db) args.push("--db", config.db);
  return args;
}

export function buildTestProfileArgs(config: { profile: string; site?: string; categories?: string[]; headed?: boolean; delayMs?: number }): string[] {
  const args = ["-m", "scraper", "--test-profile", config.profile];
  if (config.site) args.push("--site", config.site);
  appendCsv(args, "--categories", config.categories);
  appendNumber(args, "--delay-ms", config.delayMs);
  if (config.headed) args.push("--headed");
  return args;
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
  const minutes = Math.max(1, Math.round(seconds / 60));
  return { jobs, pages, duration: minutes >= 1 ? `~${minutes} min` : `~${seconds} sec` };
}

export async function runScraper(config: ScrapeRunConfig, palette: Palette, options: { json?: boolean } = {}): Promise<number> {
  const resolution = await resolvePython();
  if (!resolution.ok || !resolution.command) throw new Error(resolution.error ?? "Python interpreter is unavailable.");
  const args = buildScraperArgs(config);
  const estimate = estimateScrape(config);
  if (!options.json) console.log(`${STATUS_GLYPHS.unverified} estimated crawl time ${estimate.duration} (${estimate.jobs} jobs, ${estimate.pages} pages)`);
  const child = spawn(resolution.command, [...resolution.args, ...args], {
    cwd: process.cwd(),
    env: scraperEnv(process.env),
    stdio: ["ignore", "pipe", "pipe"]
  });
  return renderScraper(child, palette, options);
}

export async function runTestProfile(config: { profile: string; site?: string; categories?: string[]; headed?: boolean; delayMs?: number }): Promise<number> {
  const resolution = await resolvePython();
  if (!resolution.ok || !resolution.command) throw new Error(resolution.error ?? "Python interpreter is unavailable.");
  const child = spawn(resolution.command, [...resolution.args, ...buildTestProfileArgs(config)], {
    cwd: process.cwd(),
    env: scraperEnv(process.env),
    stdio: ["ignore", "inherit", "inherit"]
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function renderScraper(child: ReturnType<typeof spawn>, palette: Palette, options: { json?: boolean }): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    if (!child.stdout || !child.stderr) {
      reject(new Error("Scraper process did not expose stdout/stderr."));
      return;
    }
    child.stdout.on("data", (chunk: Buffer) => {
      const parsed = parseNdjsonChunk(buffer, chunk.toString("utf8"));
      buffer = parsed.buffer;
      for (const event of parsed.events) renderEvent(event, palette, options);
      for (const line of parsed.invalidLines) process.stderr.write(`Invalid scraper JSON: ${line}\n`);
    });
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const parsed = parseTrailingNdjson(buffer);
      for (const event of parsed.events) renderEvent(event, palette, options);
      resolve(code ?? 1);
    });
  });
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
  if (event.type === "done") console.log(palette.ok(`${STATUS_GLYPHS.ok} scrape done${event.products_written === undefined ? "" : ` (${event.products_written} products written)`}`));
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

function validatePython(candidate: PythonCandidate): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(candidate.command, [...candidate.args, "--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

function scraperEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const pythonPath = process.cwd();
  return {
    ...env,
    PYTHONPATH: env.PYTHONPATH ? `${pythonPath}${path.delimiter}${env.PYTHONPATH}` : pythonPath
  };
}

function appendCsv(args: string[], flag: string, value: string[] | undefined): void {
  if (value?.length) args.push(flag, value.join(","));
}

function appendNumber(args: string[], flag: string, value: number | undefined): void {
  if (value !== undefined) args.push(flag, String(value));
}
