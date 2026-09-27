import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ScrapeRunConfig, TestProfileConfig } from "@/contracts/scrape";
import { isMissingBrowserError } from "./process-errors";

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

export type ScrapePathPolicy = {
  resolveDatabasePath(path: string): string;
};

export const filesystemScrapePaths: ScrapePathPolicy = {
  resolveDatabasePath: (filePath) => filePath
};

export type CapturedProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export type CapturedProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
  killGraceMs?: number;
};

let cachedResolution: Promise<PythonResolution> | undefined;

export function pythonCandidates(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  exists: (filePath: string) => boolean = existsSync
): PythonCandidate[] {
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

export async function resolvePython(options: ResolveOptions = {}): Promise<PythonResolution> {
  const useCache = !options.validate && !options.exists && !options.cwd && !options.env;
  if (useCache && cachedResolution) return cachedResolution;
  const resolution = resolvePythonUncached(options);
  if (useCache) cachedResolution = resolution;
  return resolution;
}

export function resetPythonResolutionCache(): void {
  cachedResolution = undefined;
}

async function resolvePythonUncached(options: ResolveOptions): Promise<PythonResolution> {
  const validate = options.validate ?? ((candidate: PythonCandidate) =>
    validatePython(candidate, options.cwd ?? process.cwd(), options.env ?? process.env)
  );
  const errors: string[] = [];
  for (const candidate of pythonCandidates(options.cwd, options.env, options.exists)) {
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

export function buildScraperArgs(config: ScrapeRunConfig, paths: ScrapePathPolicy): string[] {
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
  if (config.db) args.push("--db", paths.resolveDatabasePath(config.db));
  return args;
}

export function buildTestProfileArgs(config: TestProfileConfig): string[] {
  const args = ["-m", "scraper", "--test-profile", config.profile];
  if (config.site) args.push("--site", config.site);
  appendCsv(args, "--categories", config.categories);
  appendNumber(args, "--delay-ms", config.delayMs);
  if (config.headed) args.push("--headed");
  return args;
}

export function buildModuleArgs(module: string, args: string[] = []): string[] {
  return ["-m", module, ...args];
}

type SpawnOptions = { cwd?: string; env?: NodeJS.ProcessEnv };

export function spawnPython(
  resolution: PythonResolution,
  args: string[],
  options?: SpawnOptions & { stdio?: "pipe" }
): ChildProcessWithoutNullStreams;
export function spawnPython(
  resolution: PythonResolution,
  args: string[],
  options: SpawnOptions & { stdio: "inherit" }
): ChildProcess;
export function spawnPython(
  resolution: PythonResolution,
  args: string[],
  options: SpawnOptions & { stdio?: "pipe" | "inherit" } = {}
): ChildProcess {
  if (!resolution.ok || !resolution.command) {
    throw new Error(resolution.error ?? "Python interpreter is unavailable.");
  }
  const cwd = options.cwd ?? process.cwd();
  return spawn(resolution.command, [...resolution.args, ...args], {
    cwd,
    env: pythonEnvironment(cwd, options.env ?? process.env),
    stdio: options.stdio === "inherit" ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"]
  });
}

export function createProcessTerminator(
  child: Pick<ChildProcess, "exitCode" | "kill">,
  graceMs = 3000
): { readonly requested: boolean; terminate(): void; clear(): void } {
  let requested = false;
  let timer: NodeJS.Timeout | undefined;
  return {
    get requested() {
      return requested;
    },
    terminate() {
      if (requested || child.exitCode !== null) return;
      requested = true;
      child.kill("SIGINT");
      timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, graceMs);
    },
    clear() {
      if (timer) clearTimeout(timer);
    }
  };
}

export function runPythonCaptured(
  resolution: PythonResolution,
  args: string[],
  options: CapturedProcessOptions
): Promise<CapturedProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawnPython(resolution, args, options);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let failure: Error | undefined;
    let processError: Error | undefined;
    const terminator = createProcessTerminator(child, options.killGraceMs);
    const deadline = setTimeout(
      () => stop(new Error(`Python process exceeded its ${options.timeoutMs} ms deadline.`)),
      options.timeoutMs
    );

    const cleanup = () => {
      clearTimeout(deadline);
      terminator.clear();
      options.signal?.removeEventListener("abort", abort);
    };
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      const error = failure ?? processError;
      if (error) reject(error);
      else resolve({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    };
    function stop(error: Error) {
      if (failure) return;
      failure = error;
      terminator.terminate();
    }
    function abort() {
      stop(new Error("Python process was cancelled."));
    }
    function capture(target: Buffer[], chunk: Buffer) {
      const remaining = options.maxOutputBytes - outputBytes;
      if (remaining <= 0) {
        stop(new Error(`Python process output exceeded ${options.maxOutputBytes} bytes.`));
        return;
      }
      target.push(chunk.subarray(0, remaining));
      outputBytes += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) stop(new Error(`Python process output exceeded ${options.maxOutputBytes} bytes.`));
    }

    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.on("error", (error) => {
      processError = error;
      if (child.pid === undefined) settle(null, null);
      else stop(error);
    });
    child.on("close", settle);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

export async function runPythonModule(
  module: string,
  args: string[],
  options: CapturedProcessOptions
): Promise<CapturedProcessResult> {
  const resolution = await resolvePython();
  if (!resolution.ok) throw new Error(resolution.error ?? "Python interpreter is unavailable.");
  return runPythonCaptured(resolution, buildModuleArgs(module, args), options);
}

function validatePython(candidate: PythonCandidate, cwd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(candidate.command, [...candidate.args, "--version"], {
      cwd,
      env: pythonEnvironment(cwd, env),
      stdio: "ignore"
    });
    let settled = false;
    const finish = (valid: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(valid);
    };
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, 3000);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

export function pythonEnvironment(cwd: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  if (clean.APPIMAGE) {
    delete clean.APPIMAGE;
    delete clean.LD_LIBRARY_PATH;
  }
  clean.PYTHONPATH = clean.PYTHONPATH ? `${cwd}${path.delimiter}${clean.PYTHONPATH}` : cwd;
  return clean;
}

function appendCsv(args: string[], flag: string, value: string[] | undefined): void {
  if (value?.length) args.push(flag, value.join(","));
}

function appendNumber(args: string[], flag: string, value: number | undefined): void {
  if (value !== undefined) args.push(flag, String(value));
}

export function isTransientCrawlerError(reason?: string): boolean {
  if (!reason) return false;
  const lower = reason.toLowerCase();
  return (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("deadline") ||
    lower.includes("abort") ||
    lower.includes("cancel") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("ebusy")
  );
}

let crawlerReadinessGeneration = 0;
let inFlightCrawlerReadiness: Promise<{ ready: boolean; reason?: string }> | undefined;
let cachedCrawlerReadiness: { ready: boolean; reason?: string } | undefined;

export function resetCrawlerEnvironmentCache(): void {
  // Same invalidation contract as a forced probe: in-flight completions are
  // fenced off by the generation bump, so they can neither overwrite fresh
  // cache nor clear a newer in-flight request.
  crawlerReadinessGeneration += 1;
  cachedCrawlerReadiness = undefined;
  inFlightCrawlerReadiness = undefined;
}

export async function checkCrawlerEnvironment(options: {
  force?: boolean;
  probeFn?: () => Promise<{ ready: boolean; reason?: string }>;
} = {}): Promise<{ ready: boolean; reason?: string }> {
  if (options.force) {
    // A forced probe must produce fresh readiness: invalidate the cache and
    // fence off any older in-flight completion via the generation bump, so it
    // can neither overwrite the fresh result nor clear the new request.
    crawlerReadinessGeneration += 1;
    cachedCrawlerReadiness = undefined;
    inFlightCrawlerReadiness = undefined;
  }
  if (cachedCrawlerReadiness) {
    return cachedCrawlerReadiness;
  }
  if (inFlightCrawlerReadiness) {
    return inFlightCrawlerReadiness;
  }

  const generation = crawlerReadinessGeneration;
  const probe = options.probeFn ?? checkCrawlerEnvironmentUncached;
  const flight: { pending?: Promise<{ ready: boolean; reason?: string }> } = {};
  flight.pending = (async () => {
    try {
      const result = await probe();
      if (generation === crawlerReadinessGeneration && !isTransientCrawlerError(result.reason)) {
        cachedCrawlerReadiness = result;
      }
      return result;
    } finally {
      if (inFlightCrawlerReadiness === flight.pending) inFlightCrawlerReadiness = undefined;
    }
  })();
  inFlightCrawlerReadiness = flight.pending;

  return flight.pending;
}

async function checkCrawlerEnvironmentUncached(): Promise<{ ready: boolean; reason?: string }> {
  const resolution = await resolvePython();
  if (!resolution.ok || !resolution.command) {
    return { ready: false, reason: "Python interpreter is unavailable" };
  }

  const probeScript = `
import sys, json, asyncio
async def check():
    try:
        import bs4
        import crawl4ai
        from playwright.async_api import async_playwright
    except ImportError as e:
        return {"ready": False, "reason": "Missing crawler dependency: " + str(e)}

    try:
        from playwright.async_api import async_playwright
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            await browser.close()
        return {"ready": True}
    except Exception as e:
        msg = str(e)
        if "Executable doesn" in msg or "playwright install" in msg or "chromium" in msg.lower():
            return {"ready": False, "reason": "Chromium is missing"}
        return {"ready": False, "reason": msg.splitlines()[0]}

try:
    res = asyncio.run(check())
    print(json.dumps(res))
except Exception as e:
    print(json.dumps({"ready": False, "reason": str(e)}))
`;

  try {
    const result = await runPythonCaptured(resolution, ["-c", probeScript], {
      timeoutMs: 8000,
      maxOutputBytes: 20_000
    });
    const output = result.stdout.trim();
    if (!output) {
      const err = result.stderr.trim();
      if (isMissingBrowserError(err)) {
        return { ready: false, reason: "Chromium is missing" };
      }
      return { ready: false, reason: err.split("\n")[0] || "Crawler probe failed" };
    }
    const lastLine = output.split("\n").filter(Boolean).pop() || "";
    const parsed = JSON.parse(lastLine) as { ready: boolean; reason?: string };
    return { ready: Boolean(parsed.ready), reason: parsed.reason };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ready: false, reason: msg };
  }
}

