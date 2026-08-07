import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

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

type ResolveOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (filePath: string) => boolean;
  validate?: (candidate: PythonCandidate) => Promise<boolean>;
};

let cachedResolution: Promise<PythonResolution> | undefined;

export function pythonCandidates(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env, exists: (filePath: string) => boolean = existsSync): PythonCandidate[] {
  const candidates: PythonCandidate[] = [];
  if (env.PYTHON_PATH) {
    candidates.push({ command: env.PYTHON_PATH, args: [], label: "PYTHON_PATH" });
  }
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

export async function resolvePython(options: ResolveOptions = {}): Promise<PythonResolution> {
  if (!options.validate && !options.exists && !options.cwd && !options.env && cachedResolution) return cachedResolution;
  const promise = resolvePythonUncached(options);
  if (!options.validate && !options.exists && !options.cwd && !options.env) cachedResolution = promise;
  return promise;
}

export function resetPythonResolutionCache(): void {
  cachedResolution = undefined;
}

async function resolvePythonUncached(options: ResolveOptions): Promise<PythonResolution> {
  const candidates = pythonCandidates(options.cwd, options.env, options.exists);
  const validate = options.validate ?? validatePython;
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      if (await validate(candidate)) {
        return { ok: true, command: candidate.command, args: candidate.args, label: candidate.label };
      }
      errors.push(`${candidate.label}: validation failed`);
    } catch (error) {
      errors.push(`${candidate.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ok: false, args: [], error: errors.join("; ") || "No Python interpreter found." };
}

function validatePython(candidate: PythonCandidate): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(candidate.command, [...candidate.args, "--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

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

export function buildTestProfileArgs(config: {
  profile: string;
  site?: string;
  categories?: string[];
  headed?: boolean;
  delayMs?: number;
}): string[] {
  const args = ["-m", "scraper", "--test-profile", config.profile];
  if (config.site) args.push("--site", config.site);
  appendCsv(args, "--categories", config.categories);
  appendNumber(args, "--delay-ms", config.delayMs);
  if (config.headed) args.push("--headed");
  return args;
}

export function spawnScraper(resolution: PythonResolution, args: string[]) {
  if (!resolution.ok || !resolution.command) throw new Error(resolution.error ?? "Python interpreter is unavailable.");
  const pythonPath = process.cwd();
  return spawn(resolution.command, [...resolution.args, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: process.env.PYTHONPATH ? `${pythonPath}${path.delimiter}${process.env.PYTHONPATH}` : pythonPath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function appendCsv(args: string[], flag: string, value: string[] | undefined): void {
  if (value?.length) args.push(flag, value.join(","));
}

function appendNumber(args: string[], flag: string, value: number | undefined): void {
  if (value !== undefined) args.push(flag, String(value));
}
