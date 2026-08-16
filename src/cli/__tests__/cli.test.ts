import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { booleanFlag, csvFlag, numberFlag, parseArgv, stringFlag } from "../arg-parser";
import { findCommand, helpText, slashCommands, subcommands } from "../commands";
import { getConfigValue, isSensitiveConfigKey, readCliConfig, setConfigValue, writeCliConfig } from "../config-store";
import { parseNdjsonChunk, parseScrapeEvent } from "../ndjson";
import { buildScraperArgs, estimateScrape, resolveCliTermination } from "../scrape";
import { createPalette, loadThemeAnsi, shouldUseColor } from "../theme";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
  tempDirs.length = 0;
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("CLI arg parsing", () => {
  it("parses positionals, boolean flags, csv flags, and negated flags", () => {
    const parsed = parseArgv(["scrape", "--profile", "india", "--categories=gpu,cpu", "--quick", "--max-pages", "5", "--no-llm-fallback"]);

    expect(parsed.command).toBe("scrape");
    expect(stringFlag(parsed.flags, "profile")).toBe("india");
    expect(csvFlag(parsed.flags, "categories")).toEqual(["gpu", "cpu"]);
    expect(booleanFlag(parsed.flags, "quick")).toBe(true);
    expect(numberFlag(parsed.flags, "maxPages")).toBe(5);
    expect(booleanFlag(parsed.flags, "llmFallback", true)).toBe(false);
  });

  it("does not greedily consume a positional argument following a boolean flag as its value", () => {
    const parsed = parseArgv(["validate", "--json", "build.json"]);
    expect(parsed.command).toBe("validate");
    expect(booleanFlag(parsed.flags, "json")).toBe(true);
    expect(parsed.positionals).toEqual(["build.json"]);
  });
});

describe("command registry", () => {
  it("uses one registry for slash commands and subcommands", () => {
    expect(findCommand("/scrape")?.subcommand).toBe("scrape");
    expect(findCommand("scrape")?.slash).toBe("/scrape");
    expect(slashCommands().map((command) => command.slash)).toContain("/theme");
    expect(subcommands().map((command) => command.subcommand)).toContain("validate");
    expect(helpText("interactive")).toContain("/exit");
  });
});

describe("CLI config store", () => {
  it("round-trips get and set through .pcbuildsage/config.json", () => {
    const cwd = createTempDir("pcbuildsage-cli-");
    const config = setConfigValue(setConfigValue({}, "theme", "nord"), "audit", "false");

    writeCliConfig(config, cwd);
    const loaded = readCliConfig(cwd);

    expect(getConfigValue(loaded, "theme")).toBe("nord");
    expect(getConfigValue(loaded, "tier2Enabled")).toBe(false);
    expect(readdirSync(path.join(cwd, ".pcbuildsage"))).toEqual(["config.json"]);
    if (process.platform !== "win32") {
      expect(statSync(path.join(cwd, ".pcbuildsage")).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(cwd, ".pcbuildsage", "config.json")).mode & 0o600).toBe(0o600);
    }
  });

  it("detects sensitive credential keys", () => {
    expect(isSensitiveConfigKey("llmChain.0.apiKey")).toBe(true);
    expect(isSensitiveConfigKey("theme")).toBe(false);
  });
});

describe("NDJSON scrape progress parsing", () => {
  it("parses split chunks and reports invalid lines", () => {
    const first = parseNdjsonChunk("", "{\"type\":\"site_started\",\"site\":\"A\"");
    const second = parseNdjsonChunk(first.buffer, "}\nnot-json\n{\"type\":\"progress\",\"site\":\"A\",\"percent\":50}\n");

    expect(second.events).toEqual([
      { type: "site_started", site: "A", category: undefined },
      { type: "progress", site: "A", category: undefined, percent: 50, page: undefined, pages_total: undefined, products_seen: undefined, skipped: undefined }
    ]);
    expect(second.invalidLines).toEqual(["not-json"]);
  });

  it("rejects malformed event shapes", () => {
    expect(parseScrapeEvent("{\"type\":\"progress\"}")).toBeUndefined();
  });
});

describe("scrape flag mapping and estimates", () => {
  const successOutcome = {
    status: "succeeded" as const,
    jobs_total: 1,
    jobs_succeeded: 1,
    jobs_failed: 0,
    jobs_skipped: 0,
    products_written: 2,
    errors: []
  };

  it("requires exactly one terminal outcome matching process exit", () => {
    expect(resolveCliTermination([successOutcome], 0)).toEqual({ outcome: successOutcome, exitCode: 0 });
    expect(resolveCliTermination([], 0)).toMatchObject({ outcome: { status: "failed" }, exitCode: 1 });
    expect(resolveCliTermination([successOutcome, successOutcome], 0)).toMatchObject({
      outcome: { status: "failed" },
      exitCode: 1
    });
    expect(resolveCliTermination([successOutcome], 1)).toMatchObject({ outcome: { status: "failed" }, exitCode: 1 });
  });

  it("maps run config to scraper args", () => {
    expect(buildScraperArgs({
      profile: "india",
      sites: ["a", "b"],
      categories: ["gpu"],
      quick: true,
      skipFresh: 24,
      noLlmFallback: true,
      maxLlmCalls: 3,
      concurrency: 2,
      delayMs: 500,
      headed: true,
      db: "tmp.db"
    })).toEqual([
      "-m", "scraper", "--json-stdout", "--profile", "india",
      "--sites", "a,b", "--categories", "gpu", "--quick", "--skip-fresh", "24",
      "--no-llm-fallback", "--max-llm-calls", "3", "--concurrency", "2",
      "--delay-ms", "500", "--headed", "--db", "tmp.db"
    ]);
  });

  it("estimates scrape work from profile JSON", () => {
    const cwd = createTempDir("pcbuildsage-profile-");
    mkdirSync(path.join(cwd, "data", "profiles"), { recursive: true });
    writeFileSync(path.join(cwd, "data", "profiles", "test.json"), JSON.stringify({
      sites: [
        { site_name: "One", categories: { gpu: { max_pages: 6 }, cpu: { max_pages: 4 } } },
        { site_name: "Two", categories: { gpu: { max_pages: 3 } } }
      ]
    }));

    expect(estimateScrape({ profile: "test", categories: ["gpu"], quick: true }, cwd)).toMatchObject({ jobs: 2, pages: 4 });
  });
});

describe("theme ansi and NO_COLOR", () => {
  it("loads ansi colors from a theme file", () => {
    const cwd = createTempDir("pcbuildsage-theme-");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(path.join(cwd, "custom.json"), JSON.stringify({ ansi: { accent: 1, ok: 2, blocking: 3, warn: 4, unverified: 5, muted: 6 } }));

    expect(loadThemeAnsi("custom", cwd)).toEqual({ accent: 1, ok: 2, blocking: 3, warn: 4, unverified: 5, muted: 6 });
  });

  it("disables color for NO_COLOR and non-TTY output", () => {
    const stream = { isTTY: true } as NodeJS.WriteStream;
    const noColorEnv: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
    expect(shouldUseColor(noColorEnv, stream)).toBe(false);
    expect(shouldUseColor({ ...process.env }, { isTTY: false } as NodeJS.WriteStream)).toBe(false);
    const palette = createPalette("sage-dark", { env: noColorEnv, stream });
    expect(palette.accent("x")).toBe("x");
  });
});
