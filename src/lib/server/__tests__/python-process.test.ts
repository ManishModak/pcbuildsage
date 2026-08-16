import { describe, expect, it } from "vitest";
import {
  buildModuleArgs,
  buildScraperArgs,
  filesystemScrapePaths,
  pythonEnvironment,
  pythonCandidates,
  runPythonCaptured,
  type PythonResolution,
  type ScrapePathPolicy
} from "../python-process";

const nodeResolution: PythonResolution = {
  ok: true,
  command: process.execPath,
  args: [],
  label: "node-test-process"
};

describe("Python caller commands", () => {
  it.each([
    ["CLI filesystem", filesystemScrapePaths, "../outside.db"],
    ["API sandbox", { resolveDatabasePath: (value: string) => `/sandbox/${value}` }, "/sandbox/../outside.db"]
  ] satisfies Array<[string, ScrapePathPolicy, string]>)
  ("applies the explicit %s database policy", (_name, paths, expectedPath) => {
    const args = buildScraperArgs({
      profile: "india",
      sites: ["one", "two"],
      categories: ["gpu"],
      quick: true,
      maxPages: 4,
      skipFresh: 12,
      noLlmFallback: true,
      maxLlmCalls: 3,
      concurrency: 2,
      delayMs: 250,
      headed: true,
      db: "../outside.db"
    }, paths);

    expect(args).toEqual([
      "-m", "scraper", "--json-stdout", "--profile", "india",
      "--sites", "one,two", "--categories", "gpu", "--quick",
      "--max-pages", "4", "--skip-fresh", "12", "--no-llm-fallback",
      "--max-llm-calls", "3", "--concurrency", "2", "--delay-ms", "250",
      "--headed", "--db", expectedPath
    ]);
  });

  it("constructs Python module invocation without locating a source file", () => {
    expect(buildModuleArgs("scraper.crawl_page", ["https://example.com"])).toEqual([
      "-m", "scraper.crawl_page", "https://example.com"
    ]);
  });

  it("keeps interpreter candidate order canonical", () => {
    const candidates = pythonCandidates("/repo", { NODE_ENV: "test", PYTHON_PATH: "/custom/python" }, (filePath) => filePath.includes(".venv"));
    expect(candidates.map((candidate) => candidate.label)).toEqual([
      "PYTHON_PATH", ".venv/Scripts/python.exe", ".venv/bin/python", "py -3", "python3", "python"
    ]);
  });

  it("removes AppImage launcher contamination without dropping unrelated variables", () => {
    expect(pythonEnvironment("/repo", {
      NODE_ENV: "test",
      APPIMAGE: "/launcher/app.AppImage",
      LD_LIBRARY_PATH: "/launcher/lib",
      KEEP_ME: "yes",
      PYTHONPATH: "/existing/python"
    })).toEqual({
      NODE_ENV: "test",
      KEEP_ME: "yes",
      PYTHONPATH: `/repo${process.platform === "win32" ? ";" : ":"}/existing/python`
    });
    expect(pythonEnvironment("/repo", { NODE_ENV: "test", LD_LIBRARY_PATH: "/user/lib" })).toMatchObject({
      LD_LIBRARY_PATH: "/user/lib"
    });
  });
});

describe("bounded process capture", () => {
  it("rejects a spawn error even if no close event follows", async () => {
    await expect(runPythonCaptured(
      { ok: true, command: "pcbuildsage-python-command-that-does-not-exist", args: [] },
      [],
      { timeoutMs: 1000, maxOutputBytes: 100 }
    )).rejects.toThrow();
  });

  it("captures successful output", async () => {
    const result = await runPythonCaptured(
      { ...nodeResolution, args: ["-e", "process.stdout.write('ok')"] },
      [],
      { timeoutMs: 1000, maxOutputBytes: 100 }
    );

    expect(result).toMatchObject({ code: 0, stdout: "ok", stderr: "" });
  });

  it("terminates output beyond the configured budget", async () => {
    await expect(runPythonCaptured(
      { ...nodeResolution, args: ["-e", "process.stdout.write('too much output'); setInterval(() => {}, 1000)"] },
      [],
      { timeoutMs: 1000, maxOutputBytes: 4, killGraceMs: 20 }
    )).rejects.toThrow("output exceeded 4 bytes");
  });

  it("kills a process that ignores the deadline interrupt", async () => {
    await expect(runPythonCaptured(
      { ...nodeResolution, args: ["-e", "process.on('SIGINT', () => {}); setInterval(() => {}, 1000)"] },
      [],
      { timeoutMs: 50, maxOutputBytes: 100, killGraceMs: 20 }
    )).rejects.toThrow("exceeded its 50 ms deadline");
  });
});
