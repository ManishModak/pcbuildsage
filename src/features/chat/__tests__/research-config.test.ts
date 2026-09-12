import { describe, it, expect, vi } from "vitest";
import { POST as probeRoute } from "@/app/api/search/probe/route";
import { consult } from "@/lib/tools/consult";
import { DEFAULT_CONFIG } from "@/lib/client-config-store";
import type { AppConfig } from "@/types";

vi.mock("@/lib/db", () => ({
  DEFAULT_DB_PATH: "mock-products.db",
  getDb: () => ({
    prepare: () => ({
      get: () => undefined,
      run: () => undefined
    })
  })
}));

describe("Research Configuration & Error Handling", () => {
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
  });

  describe("Subagent Terminal Error Handling & JSON Repair", () => {
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
});
