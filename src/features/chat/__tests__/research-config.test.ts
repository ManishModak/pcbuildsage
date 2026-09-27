import { describe, it, expect, vi } from "vitest";
import { POST as probeRoute } from "@/app/api/search/probe/route";
import { consult } from "@/lib/tools/consult";
import { createSearchClient } from "@/lib/web-search";
import {
  checkCrawlerEnvironment,
  resetCrawlerEnvironmentCache,
  isTransientCrawlerError
} from "@/lib/server/python-process";
import { DEFAULT_CONFIG } from "@/lib/client-config-store";
import type { AppConfig } from "@/types";

const mockCheckCrawlerReadiness = vi.hoisted(() => vi.fn());

// The probe route reads readiness through web-search. Mock only that seam so
// route tests cover ready/missing/transient states without a real browser;
// createSearchClient and the rest of the module stay intact.
vi.mock("@/lib/web-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/web-search")>();
  return { ...actual, checkCrawlerReadiness: mockCheckCrawlerReadiness };
});

let mockDbGetResult: unknown = undefined;

vi.mock("@/lib/db", () => ({
  DEFAULT_DB_PATH: "mock-products.db",
  getDb: () => ({
    prepare: () => ({
      get: () => mockDbGetResult,
      run: () => undefined
    })
  })
}));

describe("Research Configuration & Error Handling", () => {
  const baseConfig: AppConfig = {
    ...DEFAULT_CONFIG,
    dbPath: ":memory:",
    llm: {
      chain: [{ provider: "gemini", model: "gemini-2.5-flash", keySource: "env" }],
      roles: {
        chat: [{ provider: "gemini", model: "gemini-2.5-flash", keySource: "env" }],
        subagent: [{ provider: "gemini", model: "gemini-2.5-flash", keySource: "env" }],
        scraper: [{ provider: "gemini", model: "gemini-2.5-flash", keySource: "env" }]
      }
    },
    search: { provider: "tavily", apiKey: "tvly-key", crawlEnabled: false }
  };

  describe("Search Probe Route", () => {
    it("handles none provider cleanly", async () => {
      const req = new Request("http://localhost/api/search/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "none" })
      });
      const res = await probeRoute(req);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json).toEqual({ ok: true, resultCount: 0, message: "Search is disabled." });
    });

    it("reports error when required API key is missing", async () => {
      const req = new Request("http://localhost/api/search/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "tavily" })
      });
      const res = await probeRoute(req);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.ok).toBe(false);
      expect(json.error).toContain("tavily search API key is required");
    });

    it("distinguishes empty results from connection failure", async () => {
      // Mock fetch to simulate successful response with 0 results
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results: [] })
      } as Response);

      try {
        const req = new Request("http://localhost/api/search/probe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "tavily", apiKey: "tvly-test-key" })
        });
        const res = await probeRoute(req);
        const json = await res.json();
        expect(res.status).toBe(200);
        expect(json.ok).toBe(true);
        expect(json.resultCount).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("reports connection failure when provider returns HTTP error", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized"
      } as Response);

      try {
        const req = new Request("http://localhost/api/search/probe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "brave", apiKey: "invalid-key" })
        });
        const res = await probeRoute(req);
        const json = await res.json();
        expect(res.status).toBe(200);
        expect(json.ok).toBe(false);
        expect(json.error).toContain("brave search failed: HTTP 401");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("reports crawler readiness states without a real browser", async () => {
      mockCheckCrawlerReadiness.mockResolvedValue({ ready: true });
      const readyReq = new Request("http://localhost/api/search/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkCrawler: true })
      });
      const readyRes = await probeRoute(readyReq);
      const readyJson = await readyRes.json();
      expect(readyRes.status).toBe(200);
      expect(readyJson).toEqual({ ok: true, crawler: { ready: true }, message: "Ready" });
    });

    it("reports missing browser accurately", async () => {
      mockCheckCrawlerReadiness.mockResolvedValue({ ready: false, reason: "Chromium is missing" });
      const req = new Request("http://localhost/api/search/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkCrawler: true, recheck: true })
      });
      const res = await probeRoute(req);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.ok).toBe(false);
      expect(json.message).toContain("Unavailable: Chromium is missing");
      expect(json.crawler).toEqual({ ready: false, reason: "Chromium is missing" });
    });

    it("surfaces transient probe failures without caching them at the route", async () => {
      mockCheckCrawlerReadiness.mockResolvedValue({ ready: false, reason: "Python process exceeded its 8000 ms deadline." });
      const req = new Request("http://localhost/api/search/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkCrawler: true, recheck: true })
      });
      const res = await probeRoute(req);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.ok).toBe(false);
      expect(json.crawler).toEqual({ ready: false, reason: "Python process exceeded its 8000 ms deadline." });
    });

    it("refuses checkCrawler and spawns nothing in hosted mode", async () => {
      const prevMode = process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
      mockCheckCrawlerReadiness.mockClear();
      try {
        const req = new Request("http://localhost/api/search/probe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ checkCrawler: true, recheck: true })
        });
        const res = await probeRoute(req);
        const json = await res.json();
        expect(res.status).toBe(200);
        expect(json.ok).toBe(false);
        expect(json.message).toContain("Unavailable: Crawler is unavailable in hosted mode");
        expect(json.crawler).toEqual({ ready: false, reason: "Crawler is unavailable in hosted mode" });
        expect(mockCheckCrawlerReadiness).not.toHaveBeenCalled();
      } finally {
        if (prevMode !== undefined) {
          process.env.PCBUILDSAGE_DEPLOYMENT_MODE = prevMode;
        } else {
          delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
        }
      }
    });
  });

  describe("Capability-Specific Research Readiness Isolation", () => {
    it("disables only page crawling when browser is missing while web search succeeds", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [{ title: "DDR5 Guide", url: "https://specs.example.com", content: "DDR5 specs" }]
        })
      } as Response);

      try {
        const client = createSearchClient(
          { provider: "searxng", baseUrl: "http://localhost:8080" },
          {
            checkCrawlerReadiness: async () => ({ ready: false, reason: "Chromium is missing" })
          }
        );

        const response = await client.search("Ryzen 9700X DDR5", { crawlEnabled: true });
        expect(response.results.length).toBe(1);
        expect(response.results[0].title).toBe("DDR5 Guide");
        expect(response.results[0].snippet).toBe("DDR5 specs");
        expect(response.crawl).toEqual({
          status: "failed",
          error: "Page crawling unavailable: Chromium is missing. Web search is available."
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("reports clear error when crawl_page is invoked while browser is missing without breaking search_web", async () => {
      let crawlPageResult: unknown;
      const generateText = vi.fn().mockImplementation(async (opts) => {
        if (opts.tools?.crawl_page) {
          crawlPageResult = await opts.tools.crawl_page.execute({ url: "https://specs.example.com" });
        }
        return {
          text: JSON.stringify({ specs: { brand: "AMD", model: "Ryzen 9 9950X", aliases: [] }, sources: ["https://specs.example.com"] }),
          provider: "gemini",
          model: "gemini-2.5-flash",
          fallbackIndex: 0
        };
      });

      const result = await consult(
        {
          mode: "component_specs",
          category: "cpu",
          name: "Ryzen 9 9950X"
        },
        { ...baseConfig, search: { ...baseConfig.search, crawlEnabled: true } },
        {
          logPath: "/tmp/pcbuildsage-test-crawl-tool.jsonl",
          searchClient: { search: async () => ({ results: [{ title: "AMD Specs", url: "https://specs.example.com", snippet: "9950X" }], provider: "tavily", grounded: true }) },
          checkCrawlerReadiness: async () => ({ ready: false, reason: "Chromium is missing" }),
          generateText
        }
      );

      expect(crawlPageResult).toEqual({
        error: "Page crawling unavailable: Chromium is missing. Web search is available."
      });
      expect(result).toMatchObject({
        mode: "component_specs",
        specs: expect.objectContaining({ model: "Ryzen 9 9950X" }),
        actions: expect.arrayContaining([
          expect.objectContaining({
            tool: "crawl_page",
            url: "https://specs.example.com",
            error: "Page crawling unavailable: Chromium is missing. Web search is available."
          })
        ])
      });
    });
  });

  describe("Subagent Terminal Error Handling & JSON Repair", () => {
    it("halts immediately on terminal quota error without retrying", async () => {
      let callCount = 0;
      const generateText = vi.fn().mockImplementation(async () => {
        callCount++;
        throw new Error("Resource has been exhausted (e.g. check quota) 429 free-models-per-day");
      });

      const result = await consult(
        {
          mode: "component_specs",
          category: "cpu",
          name: "Novel Experimental GPU 9990XT"
        },
        baseConfig,
        {
          logPath: "/tmp/pcbuildsage-test-terminal.jsonl",
          searchClient: { search: async () => ({ results: [], provider: "tavily", grounded: true }) },
          generateText
        }
      );

      expect(callCount).toBe(1); // Did not repeat or retry
      expect(result).toMatchObject({
        mode: "component_specs",
        error: expect.stringContaining("429"),
        retryable: false,
        label: "unverified"
      });
    });

    it("classifies rejected credentials and redacts sensitive API keys", async () => {
      const generateText = vi.fn().mockImplementation(async () => {
        throw new Error("HTTP 401 Unauthorized: Invalid API key sk-ant-api03-abcdef12345678901234567890 passed");
      });

      const result = await consult(
        {
          mode: "component_specs",
          category: "cpu",
          name: "Core Ultra 285K"
        },
        baseConfig,
        {
          logPath: "/tmp/pcbuildsage-test-creds.jsonl",
          searchClient: { search: async () => ({ results: [], provider: "tavily", grounded: true }) },
          generateText
        }
      );

      expect(result).toMatchObject({
        mode: "component_specs",
        error: "Research provider rejected the API key. Update it in Settings.",
        detail: expect.not.stringContaining("sk-ant-api03-abcdef12345678901234567890"),
        label: "unverified"
      });
    });

    it("classifies timeout and preserves user configuration preference", async () => {
      const generateText = vi.fn().mockImplementation(async () => {
        const timeoutErr = new Error("The operation timed out after 30000ms");
        timeoutErr.name = "TimeoutError";
        throw timeoutErr;
      });

      const configCopy = { ...baseConfig, tier2Enabled: true, search: { ...baseConfig.search, crawlEnabled: true } };

      const result = await consult(
        {
          mode: "component_specs",
          category: "cpu",
          name: "Core Ultra 285K"
        },
        configCopy,
        {
          logPath: "/tmp/pcbuildsage-test-timeout.jsonl",
          searchClient: { search: async () => ({ results: [], provider: "tavily", grounded: true }) },
          generateText
        }
      );

      expect(result).toMatchObject({
        mode: "component_specs",
        error: "Research timed out. Specifications remain unverified.",
        label: "unverified"
      });

      // Crucial: temporary timeout must NOT alter user configuration preference!
      expect(configCopy.tier2Enabled).toBe(true);
      expect(configCopy.search.crawlEnabled).toBe(true);
    });

    it("performs JSON repair on schema error without passing web search tools", async () => {
      const calls: Array<{ tools?: Record<string, unknown>; prompt?: string }> = [];
      const generateText = vi.fn().mockImplementation(async (opts) => {
        calls.push({ tools: opts.tools, prompt: opts.prompt });
        if (calls.length === 1) {
          // First attempt outputs invalid schema (missing model string)
          return {
            text: JSON.stringify({ specs: { brand: "AMD", aliases: [] }, sources: [] }),
            provider: "gemini",
            model: "gemini-2.5-flash",
            fallbackIndex: 0
          };
        }
        // Second attempt outputs repaired schema
        return {
          text: JSON.stringify({ specs: { brand: "AMD", model: "Ryzen 7 7800X3D", aliases: [] }, sources: ["https://amd.com"] }),
          provider: "gemini",
          model: "gemini-2.5-flash",
          fallbackIndex: 0
        };
      });

      const result = await consult(
        {
          mode: "component_specs",
          category: "cpu",
          name: "Novel Experimental GPU 9990XT"
        },
        baseConfig,
        {
          logPath: "/tmp/pcbuildsage-test-repair.jsonl",
          searchClient: { search: async () => ({ results: [{ title: "AMD", url: "https://amd.com", snippet: "CPU specs" }], provider: "tavily", grounded: true }) },
          generateText
        }
      );

      expect(calls.length).toBe(2);
      // First call has web search tools
      expect(calls[0].tools).toBeDefined();
      expect(calls[0].tools?.search_web).toBeDefined();

      // Second call (JSON repair) does NOT have web search tools!
      expect(calls[1].tools).toBeUndefined();
      expect(calls[1].prompt).toContain("Previous response failed JSON/schema validation");
      expect(calls[1].prompt).toContain("Extract factual registry specs for this cpu: Novel Experimental GPU 9990XT.");
      expect(calls[1].prompt).toContain('Return only JSON with shape {"specs":{...},"sources":[...]}');
      expect(calls[1].prompt).toContain("https://amd.com");

      // Successfully recovered
      expect(result).toMatchObject({
        mode: "component_specs",
        specs: expect.objectContaining({ brand: "AMD", model: "Ryzen 7 7800X3D" })
      });
    });
  });

  describe("Crawling Preference Enforcement (Gap 1)", () => {
    it("reports page crawling is disabled when user preference has crawlEnabled=false without invoking browser check", async () => {
      let crawlPageResult: unknown;
      const crawlerChecker = vi.fn().mockResolvedValue({ ready: true });
      const generateText = vi.fn().mockImplementation(async (opts) => {
        if (opts.tools?.crawl_page) {
          crawlPageResult = await opts.tools.crawl_page.execute({ url: "https://specs.example.com" });
        }
        return {
          text: JSON.stringify({ specs: { brand: "AMD", model: "Ryzen 7 7800X3D", aliases: [] }, sources: ["https://specs.example.com"] }),
          provider: "gemini",
          model: "gemini-2.5-flash",
          fallbackIndex: 0
        };
      });

      const result = await consult(
        {
          mode: "component_specs",
          category: "cpu",
          name: "Ryzen 7 7800X3D"
        },
        { ...baseConfig, search: { ...baseConfig.search, crawlEnabled: false } },
        {
          logPath: "/tmp/pcbuildsage-test-crawl-pref.jsonl",
          searchClient: { search: async () => ({ results: [{ title: "AMD Specs", url: "https://specs.example.com", snippet: "7800X3D" }], provider: "tavily", grounded: true }) },
          checkCrawlerReadiness: crawlerChecker,
          generateText
        }
      );

      // Crawl was rejected based on user preference
      expect(crawlPageResult).toEqual({
        error: "Page crawling is disabled. Web search is available."
      });
      // Crawler readiness check was NEVER called because crawling is disabled!
      expect(crawlerChecker).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        mode: "component_specs",
        specs: expect.objectContaining({ model: "Ryzen 7 7800X3D" }),
        actions: expect.arrayContaining([
          expect.objectContaining({
            tool: "crawl_page",
            url: "https://specs.example.com",
            error: "Page crawling is disabled. Web search is available."
          })
        ])
      });
    });
  });

  describe("Unnecessary Browser Checks Avoidance (Gap 2)", () => {
    it("does not check crawler readiness on cached research hit", async () => {
      mockDbGetResult = {
        key: "ryzen-7-7800x3d",
        specs: JSON.stringify({ brand: "AMD", model: "Ryzen 7 7800X3D", aliases: [] }),
        confidence: "high",
        sources: JSON.stringify(["https://amd.com"])
      };
      const crawlerChecker = vi.fn().mockResolvedValue({ ready: true });

      try {
        const result = await consult(
          {
            mode: "component_specs",
            category: "cpu",
            name: "Ryzen 7 7800X3D"
          },
          { ...baseConfig, search: { ...baseConfig.search, crawlEnabled: true } },
          {
            logPath: "/tmp/pcbuildsage-test-cache-nobrowser.jsonl",
            checkCrawlerReadiness: crawlerChecker
          }
        );

        expect(result).toMatchObject({
          cached: true,
          specs: expect.objectContaining({ model: "Ryzen 7 7800X3D" })
        });
        // Never checked the browser because it was cached!
        expect(crawlerChecker).not.toHaveBeenCalled();
      } finally {
        mockDbGetResult = undefined;
      }
    });

    it("does not check crawler readiness for API-only research without crawl", async () => {
      const crawlerChecker = vi.fn().mockResolvedValue({ ready: true });
      const generateText = vi.fn().mockResolvedValue({
        text: JSON.stringify({ specs: { brand: "Intel", model: "Core i7-14700K", aliases: [] }, sources: ["https://intel.com"] }),
        provider: "gemini",
        model: "gemini-2.5-flash",
        fallbackIndex: 0
      });

      const result = await consult(
        {
          mode: "component_specs",
          category: "cpu",
          name: "Core i7-14700K"
        },
        { ...baseConfig, search: { ...baseConfig.search, crawlEnabled: false } },
        {
          logPath: "/tmp/pcbuildsage-test-apionly-nobrowser.jsonl",
          searchClient: { search: async () => ({ results: [{ title: "Intel", url: "https://intel.com", snippet: "14700K" }], provider: "tavily", grounded: true }) },
          checkCrawlerReadiness: crawlerChecker,
          generateText
        }
      );

      expect(result).toMatchObject({
        mode: "component_specs",
        specs: expect.objectContaining({ model: "Core i7-14700K" })
      });
      // API-only research never checked browser readiness
      expect(crawlerChecker).not.toHaveBeenCalled();
    });
  });

  describe("Transient Probe Failures Caching (Gap 3)", () => {
    it("does not cache transient timeouts, allowing subsequent checks to re-probe", async () => {
      resetCrawlerEnvironmentCache();
      let probeCount = 0;
      const probeFn = vi.fn().mockImplementation(async () => {
        probeCount++;
        if (probeCount === 1) {
          return { ready: false, reason: "Python process exceeded its 8000 ms deadline." };
        }
        return { ready: true };
      });

      const firstResult = await checkCrawlerEnvironment({ probeFn });
      expect(firstResult).toEqual({ ready: false, reason: "Python process exceeded its 8000 ms deadline." });
      expect(probeCount).toBe(1);

      // Crucial: second call MUST re-probe instead of returning cached timeout failure!
      const secondResult = await checkCrawlerEnvironment({ probeFn });
      expect(secondResult).toEqual({ ready: true });
      expect(probeCount).toBe(2);

      // And once successful, success IS cached
      const thirdResult = await checkCrawlerEnvironment({ probeFn });
      expect(thirdResult).toEqual({ ready: true });
      expect(probeCount).toBe(2); // Not called a 3rd time
    });

    it("caches permanent failures like missing Chromium without re-probing", async () => {
      resetCrawlerEnvironmentCache();
      let probeCount = 0;
      const probeFn = vi.fn().mockImplementation(async () => {
        probeCount++;
        return { ready: false, reason: "Chromium is missing" };
      });

      const firstResult = await checkCrawlerEnvironment({ probeFn });
      expect(firstResult).toEqual({ ready: false, reason: "Chromium is missing" });
      expect(probeCount).toBe(1);

      // Second call uses cached result for permanent configuration issue
      const secondResult = await checkCrawlerEnvironment({ probeFn });
      expect(secondResult).toEqual({ ready: false, reason: "Chromium is missing" });
      expect(probeCount).toBe(1); // Cached!
    });

    it("identifies transient errors accurately via isTransientCrawlerError", () => {
      expect(isTransientCrawlerError("Python process exceeded its 8000 ms deadline.")).toBe(true);
      expect(isTransientCrawlerError("Command timed out")).toBe(true);
      expect(isTransientCrawlerError("Operation aborted")).toBe(true);
      expect(isTransientCrawlerError("AbortError: aborted")).toBe(true);
      expect(isTransientCrawlerError("Request canceled")).toBe(true);
      expect(isTransientCrawlerError("Request cancelled")).toBe(true);
      expect(isTransientCrawlerError("ECONNRESET")).toBe(true);
      expect(isTransientCrawlerError("Chromium is missing")).toBe(false);
      expect(isTransientCrawlerError("Missing crawler dependency: crawl4ai")).toBe(false);
      expect(isTransientCrawlerError("No Python interpreter found.")).toBe(false);
      expect(isTransientCrawlerError(undefined)).toBe(false);
    });
  });

  describe("Readiness Recheck Races", () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => { resolve = r; });
      return { promise, resolve };
    }

    it("a stale probe resolving after a forced recheck cannot overwrite fresh cache", async () => {
      resetCrawlerEnvironmentCache();
      const oldGate = deferred<{ ready: boolean; reason?: string }>();
      const newGate = deferred<{ ready: boolean; reason?: string }>();
      let calls = 0;
      const probeFn = vi.fn().mockImplementation(() => {
        calls++;
        return calls === 1 ? oldGate.promise : newGate.promise;
      });

      const first = checkCrawlerEnvironment({ probeFn });
      const forced = checkCrawlerEnvironment({ probeFn, force: true });
      expect(calls).toBe(2);

      // Fresh probe completes first and caches ready:true.
      newGate.resolve({ ready: true });
      await expect(forced).resolves.toEqual({ ready: true });

      // Stale probe completes last: returned to its caller but never cached.
      oldGate.resolve({ ready: false, reason: "Chromium is missing" });
      await expect(first).resolves.toEqual({ ready: false, reason: "Chromium is missing" });

      await expect(checkCrawlerEnvironment({ probeFn })).resolves.toEqual({ ready: true });
      expect(calls).toBe(2);
    });

    it("a stale probe resolving before the forced recheck still loses", async () => {
      resetCrawlerEnvironmentCache();
      const oldGate = deferred<{ ready: boolean; reason?: string }>();
      const newGate = deferred<{ ready: boolean; reason?: string }>();
      let calls = 0;
      const probeFn = vi.fn().mockImplementation(() => {
        calls++;
        return calls === 1 ? oldGate.promise : newGate.promise;
      });

      const first = checkCrawlerEnvironment({ probeFn });
      const forced = checkCrawlerEnvironment({ probeFn, force: true });

      // Stale probe completes first: not cached (generation already bumped).
      oldGate.resolve({ ready: false, reason: "Chromium is missing" });
      await expect(first).resolves.toEqual({ ready: false, reason: "Chromium is missing" });

      newGate.resolve({ ready: true });
      await expect(forced).resolves.toEqual({ ready: true });

      await expect(checkCrawlerEnvironment({ probeFn })).resolves.toEqual({ ready: true });
      expect(calls).toBe(2);
    });

    it("reset during flight invalidates the stale completion", async () => {
      resetCrawlerEnvironmentCache();
      const oldGate = deferred<{ ready: boolean; reason?: string }>();
      const probeFn = vi.fn().mockReturnValue(oldGate.promise);

      const first = checkCrawlerEnvironment({ probeFn });
      resetCrawlerEnvironmentCache();
      oldGate.resolve({ ready: true });
      await expect(first).resolves.toEqual({ ready: true });

      // Stale completion cached nothing: the next call re-probes.
      const fresh = checkCrawlerEnvironment({ probeFn: async () => ({ ready: false, reason: "Chromium is missing" }) });
      await expect(fresh).resolves.toEqual({ ready: false, reason: "Chromium is missing" });
      expect(probeFn).toHaveBeenCalledTimes(1);
    });
  });

});
