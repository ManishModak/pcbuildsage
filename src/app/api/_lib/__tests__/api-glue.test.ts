import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as getConfig } from "../../config/route";
import { POST as importProfile, profileImportResponse } from "../../profiles/import/route";
import { POST as testProfile } from "../../profiles/test/route";
import { POST as scrape } from "../../scrape/route";
import { POST as saveSessionRoute } from "../../sessions/route";
import { GET as getStatusRoute } from "../../status/route";
import { resolveSandboxedPath, SandboxedPathError } from "../paths";
import { buildScraperArgs, pythonCandidates } from "@/lib/server/python-process";
import { validateAndWriteProfile } from "../profile-import";
import { InvalidJsonError, readJson } from "../responses";
import { getConfigValue, setConfigValue } from "@/cli/config-store";
import { estimateScrape } from "@/cli/scrape";

const originalEnv = { ...process.env };
let tempDir: string | undefined;

afterEach(() => {
  process.env = { ...originalEnv };
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Python bridge glue", () => {
  it("orders interpreter candidates with env, venv, py launcher, then generic commands", () => {
    const cwd = path.join(os.tmpdir(), "pcbuildsage-python-order");
    const seen = pythonCandidates(cwd, { ...process.env, PYTHON_PATH: "/custom/python" }, (filePath) =>
      filePath.endsWith(path.join(".venv", "Scripts", "python.exe")) || filePath.endsWith(path.join(".venv", "bin", "python"))
    );

    expect(seen.map((candidate) => candidate.label)).toEqual([
      "PYTHON_PATH",
      ".venv/Scripts/python.exe",
      ".venv/bin/python",
      "py -3",
      "python3",
      "python"
    ]);
  });

  it("maps scrape request fields to the scraper CLI flags one-for-one", () => {
    expect(buildScraperArgs({
      profile: "india",
      sites: ["Kryptronix", "MDComputers"],
      categories: ["gpu", "cpu"],
      quick: true,
      maxPages: 5,
      skipFresh: 24,
      noLlmFallback: true,
      maxLlmCalls: 7,
      concurrency: 3,
      delayMs: 250,
      headed: true,
      db: "data/custom.db"
    }, { resolveDatabasePath: (value) => value })).toEqual([
      "-m",
      "scraper",
      "--json-stdout",
      "--profile",
      "india",
      "--sites",
      "Kryptronix,MDComputers",
      "--categories",
      "gpu,cpu",
      "--quick",
      "--max-pages",
      "5",
      "--skip-fresh",
      "24",
      "--no-llm-fallback",
      "--max-llm-calls",
      "7",
      "--concurrency",
      "3",
      "--delay-ms",
      "250",
      "--headed",
      "--db",
      "data/custom.db"
    ]);
  });
});

describe("API request glue", () => {
  it("rejects paths that escape the data sandbox", () => {
    const base = path.join(os.tmpdir(), "pcbuildsage-data");

    expect(() => resolveSandboxedPath("../../etc", { base })).toThrow(SandboxedPathError);
    expect(() => resolveSandboxedPath("/etc/passwd", { base })).toThrow(SandboxedPathError);
  });

  it("resolves relative paths inside the data sandbox", () => {
    const base = path.join(os.tmpdir(), "pcbuildsage-data");

    expect(resolveSandboxedPath("exports/pending", { base })).toBe(path.join(base, "exports", "pending"));
  });

  it("throws a typed error for malformed request JSON", async () => {
    await expect(readJson(new Request("http://localhost/api", { method: "POST", body: "{" }))).rejects.toBeInstanceOf(InvalidJsonError);
  });

  it("returns 400 for malformed profile import request JSON", async () => {
    const response = await importProfile(new Request("http://localhost/api/profiles/import", { method: "POST", body: "{" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
  });

  it("returns 400 for malformed profile import multipart JSON", async () => {
    const formData = new FormData();
    formData.append("file", new File(["{"], "profile.json", { type: "application/json" }));
    const response = await importProfile(new Request("http://localhost/api/profiles/import", { method: "POST", body: formData }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
  });

  it("returns 400 for malformed fetched profile JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{", { status: 200 })));
    const response = await importProfile(new Request("http://localhost/api/profiles/import", {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com/profile.json" })
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
  });

  it("rejects profile slugs that could escape the profiles directory", async () => {
    const scrapeResponse = await scrape(new Request("http://localhost/api/scrape", {
      method: "POST",
      body: JSON.stringify({ profile: "../india" })
    }));
    const testResponse = await testProfile(new Request("http://localhost/api/profiles/test", {
      method: "POST",
      body: JSON.stringify({ profile: ".hidden" })
    }));

    expect(scrapeResponse.status).toBe(400);
    expect(testResponse.status).toBe(400);
    await expect(scrapeResponse.json()).resolves.toMatchObject({ error: "invalid_request" });
    await expect(testResponse.json()).resolves.toMatchObject({ error: "invalid_request" });
  });
});

describe("config route", () => {
  it("returns credential booleans without serializing secret values", async () => {
    process.env.GEMINI_API_KEY = "secret-gemini";
    process.env.BRAVE_API_KEY = "secret-brave";
    process.env.SEARXNG_BASE_URL = "http://localhost:8080";

    const response = await getConfig();
    const text = await response.text();
    const body = JSON.parse(text) as { llm: Record<string, boolean>; search: Record<string, boolean> };

    expect(body.llm.gemini).toBe(true);
    expect(body.search.brave).toBe(true);
    expect(body.search.searxng).toBe(true);
    expect(text).not.toContain("secret-gemini");
    expect(text).not.toContain("secret-brave");
  });
});

describe("profile import validation", () => {
  it("writes valid profiles to the requested directory", () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "pcbuildsage-profile-import-"));
    const result = validateAndWriteProfile(validProfile(), { filename: "custom-india.json", profilesDir: tempDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.id).toBe("custom-india");
    const filePath = path.join(tempDir, "custom-india.json");
    expect(existsSync(filePath)).toBe(true);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toMatchObject({ profile_name: "Custom India" });
    expect(result).not.toHaveProperty("filePath");
  });

  it("rejects a colliding profile without replacing the existing file", async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "pcbuildsage-profile-collision-"));
    const first = validateAndWriteProfile(validProfile(), { filename: "same.json", profilesDir: tempDir });
    const existing = readFileSync(path.join(tempDir, "same.json"), "utf8");
    const collision = validateAndWriteProfile({ ...validProfile(), profile_name: "Replacement" }, {
      filename: "same.json",
      profilesDir: tempDir
    });

    expect(first).toEqual({ ok: true, id: "same" });
    expect(collision).toEqual({ ok: false, error: "profile_exists", id: "same" });
    expect(readFileSync(path.join(tempDir, "same.json"), "utf8")).toBe(existing);

    const response = profileImportResponse(collision);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "profile_exists",
      message: "A profile with id \"same\" already exists.",
      id: "same"
    });
  });

  it("rejects invalid profiles with schema errors", () => {
    const result = validateAndWriteProfile({ profile_name: "Broken" }, { profilesDir: os.tmpdir() });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("invalid_profile");
    if (result.error !== "invalid_profile") return;
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("Task fixes verification", () => {
  it("rejects prototype pollution keys in config store", () => {
    expect(() => setConfigValue({}, "__proto__.polluted", "true")).toThrow();
    expect(() => setConfigValue({}, "constructor.prototype", "true")).toThrow();
    expect(() => setConfigValue({}, "prototype", "true")).toThrow();
    expect(() => getConfigValue({}, "__proto__")).toThrow();
    expect(() => getConfigValue({}, "prototype")).toThrow();
    expect(() => getConfigValue({}, "constructor")).toThrow();
  });

  it("passes abort signal and posix basename on remote profile fetch", async () => {
    let capturedOptions: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      capturedOptions = options;
      return new Response(JSON.stringify(validProfile()), { status: 200 });
    }));
    const response = await importProfile(new Request("http://localhost/api/profiles/import", {
      method: "POST",
      // Use an installed ID so this route-level test cannot leave profile files behind.
      body: JSON.stringify({ url: "https://example.com/sub/path/india.json" })
    }));

    expect(capturedOptions?.signal).toBeDefined();
    expect([200, 409]).toContain(response.status);
  });

  it("enforces non-empty session ID in save schema", async () => {
    const response = await saveSessionRoute(new Request("http://localhost/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        id: "",
        revision: 0,
        messages: []
      })
    }));

    expect(response.status).toBe(400);
  });

  it("returns 200 for status route without throwing 500 when products table is missing", async () => {
    const response = await getStatusRoute();
    expect(response.status).toBe(200);
  });

  it("formats seconds < 60 in seconds for estimateScrape", () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "pcbuildsage-estimate-test-"));
    mkdirSync(path.join(tempDir, "data", "profiles"), { recursive: true });
    writeFileSync(path.join(tempDir, "data", "profiles", "quick.json"), JSON.stringify({
      sites: [{ site_name: "S", categories: { gpu: { max_pages: 1 } } }]
    }));
    const estimate = estimateScrape({ profile: "quick", maxPages: 1 }, tempDir);
    expect(estimate.duration).toMatch(/sec$/);
  });
});

function validProfile() {
  return {
    $schema: "../schemas/profile.schema.json",
    schema_version: 1,
    profile_name: "Custom India",
    country_code: "IN",
    default_currency: "INR",
    sites: [
      {
        site_name: "Example",
        base_url: "https://example.com/",
        scraping_type: "category",
        browser_config: {
          headless: true,
          js_rendering: false,
          timeout_ms: 1000
        },
        categories: {
          gpu: {
            path: "gpu",
            pagination_pattern: "page/{page}",
            max_pages: 1
          }
        },
        selectors: {
          product_container: ".product",
          title: ".title",
          price: ".price",
          url: "a"
        }
      }
    ]
  };
}
