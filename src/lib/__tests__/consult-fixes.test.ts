import { describe, expect, it, vi, beforeEach } from "vitest";
import { resolveConfig } from "../config";
import {
  consult,
  registryKey,
  isRegistryStale,
  scoreResearchConfidence,
  toCitedSources,
  mergeAuditFindings,
  sanitizeConsultText,
  REGISTRY_TTL_MS,
  CHAT_SOURCE_SNIPPET_CAP,
} from "../tools/consult";
import type { SearchClient } from "../web-search";
import type { generateTextWithFallback } from "@/lib/llm/client";

const state = vi.hoisted(() => ({
  registry: new Map<string, { specs: string; confidence: string; sources: string; researched_at: string; category: string }>(),
  audit: new Map<string, { verdict: string; checked_at: string }>(),
}));

vi.mock("../db", () => ({
  DEFAULT_DB_PATH: "mock-products.db",
  getDb: () => ({
    prepare: (sql: string) => {
      if (sql.includes("FROM registry_research")) {
        return { get: (key: string) => state.registry.get(key) };
      }
      if (sql.includes("INTO registry_research")) {
        return {
          run: (key: string, category: string, specs: string, sources: string, confidence: string, researched_at: string) =>
            state.registry.set(key, { specs, confidence, sources, researched_at, category }),
        };
      }
      if (sql.includes("FROM audit_cache")) {
        return { get: (pair: string) => state.audit.get(pair) };
      }
      if (sql.includes("INTO audit_cache")) {
        return { run: (pair: string, verdict: string, checked_at: string) => state.audit.set(pair, { verdict, checked_at }) };
      }
      return { get: () => undefined, run: () => undefined };
    },
  }),
}));

function configWithMockDb() {
  state.registry.clear();
  state.audit.clear();
  return resolveConfig({ dbPath: "mock-products.db", llmChain: "ollama:test-model", subagentLlmChain: "ollama:test-subagent", searchProvider: "none" });
}

const searchClient: SearchClient = {
  async search() {
    return {
      provider: "duckduckgo",
      grounded: true,
      results: [
        { title: "Official specs", url: "https://example.com/cpu", snippet: "socket AM5" },
        { title: "Review", url: "https://example.com/review", snippet: "great chip" },
      ],
    };
  },
};

beforeEach(() => {
  state.registry.clear();
  state.audit.clear();
  vi.unstubAllEnvs();
});

describe("registry cache key + TTL", () => {
  it("includes category in the key", () => {
    expect(registryKey("cpu", "Ryzen 7 9700X")).not.toBe(registryKey("motherboard", "Ryzen 7 9700X"));
    expect(registryKey("cpu", "Ryzen 7 9700X")).toContain(":");
  });

  it("treats stale research as a miss", () => {
    expect(isRegistryStale(new Date(Date.now() - REGISTRY_TTL_MS - 1000).toISOString(), Date.now())).toBe(true);
    expect(isRegistryStale(new Date().toISOString(), Date.now())).toBe(false);
    // Legacy rows without a timestamp stay a hit for backward compatibility.
    expect(isRegistryStale(undefined, Date.now())).toBe(false);
  });

  it("refetches stale category-keyed entries", async () => {
    const config = configWithMockDb();
    const key = registryKey("cpu", "Stale Chip");
    state.registry.set(key, {
      specs: JSON.stringify({ brand: "Old", model: "Stale Chip", aliases: [] }),
      confidence: "low",
      sources: JSON.stringify([]),
      category: "cpu",
      researched_at: new Date(Date.now() - REGISTRY_TTL_MS - 5000).toISOString(),
    });
    const result = (await consult({ mode: "component_specs", name: "Stale Chip", category: "cpu" }, config, {
      searchClient,
      logPath: "/tmp/pcbuildsage-test-stale.jsonl",
      generateText: (async () => ({
        text: JSON.stringify({ specs: { brand: "AMD", model: "Stale Chip", aliases: [] }, sources: ["https://example.com/cpu"] }),
        provider: "ollama",
        model: "test-subagent",
        fallbackIndex: 0,
      })) as unknown as typeof generateTextWithFallback,
    })) as { cached?: boolean; specs: { brand: string } };
    expect(result.cached).not.toBe(true);
    expect(result.specs.brand).toBe("AMD");
  });
});

describe("confidence from source quality", () => {
  it("scores high/medium/low", () => {
    const grounded = { results: [{ title: "a", url: "https://a.example", snippet: "x" }, { title: "b", url: "https://b.example", snippet: "y" }], provider: "tavily", grounded: true } as never;
    expect(scoreResearchConfidence(grounded, ["https://a.example"])).toBe("high");
    expect(scoreResearchConfidence({ results: [{ title: "a", url: "https://a.example", snippet: "x" }], provider: "tavily", grounded: true } as never, [])).toBe("medium");
    expect(scoreResearchConfidence({ results: [], provider: "none", grounded: false } as never, [])).toBe("low");
  });

  it("gives high only when a cited URL was seen in grounding or crawled", () => {
    const grounded = { results: [{ title: "a", url: "https://a.example", snippet: "x" }, { title: "b", url: "https://b.example", snippet: "y" }], provider: "tavily", grounded: true } as never;
    // A URL the model made up (never searched or crawled) does not count.
    expect(scoreResearchConfidence(grounded, ["https://invented.example/specs"])).toBe("medium");
    expect(scoreResearchConfidence(grounded, ["https://invented.example/specs"], ["https://invented.example/specs"])).toBe("high");
  });
});

describe("sources actually used", () => {
  it("returns cited sources truncated, not raw page text", () => {
    const raw = `prefix-${"z".repeat(5000)}-suffix-tail-that-must-not-appear`;
    const cited = toCitedSources(["https://example.com/cpu"], [{ title: "Official", url: "https://example.com/cpu", snippet: raw }]);
    expect(cited).toHaveLength(1);
    expect(cited[0].url).toBe("https://example.com/cpu");
    expect(cited[0].snippet!.length).toBeLessThanOrEqual(CHAT_SOURCE_SNIPPET_CAP);
    expect(cited[0].snippet).not.toContain("suffix-tail-that-must-not-appear");
    expect(raw.length).toBeGreaterThan(CHAT_SOURCE_SNIPPET_CAP);
  });

  it("component_specs serves facts plus citations", async () => {
    const config = configWithMockDb();
    const result = (await consult({ mode: "component_specs", name: "Cited Chip", category: "cpu" }, config, {
      searchClient: {
        async search() {
          return {
            provider: "tavily",
            grounded: true,
            results: [
              { title: "Used", url: "https://example.com/used", snippet: "used snippet" },
              { title: "Unused", url: "https://example.com/unused", snippet: "unused snippet" },
            ],
          };
        },
      },
      logPath: "/tmp/pcbuildsage-test-cited.jsonl",
      generateText: (async () => ({
        text: JSON.stringify({ specs: { brand: "AMD", model: "Cited Chip", aliases: [] }, sources: ["https://example.com/used"] }),
        provider: "ollama",
        model: "test-subagent",
        fallbackIndex: 0,
      })) as unknown as typeof generateTextWithFallback,
    })) as { sources: Array<{ url: string }> };
    expect(result.sources.map((source) => source.url)).toEqual(["https://example.com/used"]);
  });
});

describe("audit findings empty/multiple", () => {
  it("maps empty findings to ok with a note", () => {
    const verdict = mergeAuditFindings([], "cpu:X|motherboard:Y");
    expect(verdict.severity).toBe("ok");
  });

  it("merges multiple findings with highest severity winning", () => {
    const verdict = mergeAuditFindings(
      [
        { severity: "ok", detail: "fine", sources: [] },
        { severity: "warning", detail: "check BIOS", sources: ["https://example.com/bios"] },
      ],
      "cpu:X|motherboard:Y"
    );
    expect(verdict.severity).toBe("warning");
    expect(verdict.detail).toContain("check BIOS");
    expect(verdict.sources).toContain("https://example.com/bios");
  });
});

describe("key redaction", () => {
  it("covers gsk_, Brave BSA, and Exa formats plus live env values", () => {
    vi.stubEnv("GROQ_API_KEY", "gsk_livevalue1234567890");
    expect(sanitizeConsultText("key gsk_abcDEF1234567890 end")).toContain("[REDACTED]");
    expect(sanitizeConsultText("key BSAabcDEF1234567890 end")).toContain("[REDACTED]");
    expect(sanitizeConsultText("key exa_abcDEF123456 end")).toContain("[REDACTED]");
    expect(sanitizeConsultText("leaked gsk_livevalue1234567890 here")).not.toContain("gsk_livevalue1234567890");
    expect(sanitizeConsultText("tvly-abcDEF1234567890")).toContain("[REDACTED]");
  });
});

describe("subagent abort + budgets", () => {
  it("honours user Stop without calling the model", async () => {
    const config = configWithMockDb();
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const result = (await consult({ mode: "component_specs", name: "Cancelled Chip", category: "cpu" }, config, {
      searchClient,
      logPath: "/tmp/pcbuildsage-test-abort.jsonl",
      abortSignal: controller.signal,
      generateText: (async () => {
        calls += 1;
        return { text: "{}", provider: "x", model: "y", fallbackIndex: 0 };
      }) as unknown as typeof generateTextWithFallback,
    })) as { error: string };
    expect(calls).toBe(0);
    expect(result.error).toMatch(/cancelled/i);
  });

  it("caps crawl calls per subagent turn", async () => {
    const config = resolveConfig({
      dbPath: "mock-products.db",
      llmChain: "ollama:test-model",
      subagentLlmChain: "ollama:test-subagent",
      searchProvider: "tavily",
    });
    const result = (await consult({ mode: "component_specs", name: "Budget Chip", category: "cpu" }, {
      ...config,
      search: { ...config.search, crawlEnabled: true },
    }, {
      searchClient,
      logPath: "/tmp/pcbuildsage-test-budget.jsonl",
      checkCrawlerReadiness: async () => ({ ready: true }),
      crawlRunner: async () => ({ code: 0, signal: null, stdout: "spec text", stderr: "" }),
      crawlPreflight: async () => {},
      generateText: (async (opts: { tools?: Record<string, { execute: (input: unknown) => Promise<unknown> }> }) => {
        const crawl = opts.tools?.crawl_page;
        if (!crawl) throw new Error("crawl_page tool missing");
        let last: unknown;
        for (let index = 0; index < 6; index += 1) {
          last = await crawl.execute({ url: "https://example.com/page" });
        }
        expect(last).toMatchObject({ error: expect.stringContaining("budget exhausted") });
        return {
          text: JSON.stringify({ specs: { brand: "AMD", model: "Budget Chip", aliases: [] }, sources: ["https://example.com/cpu"] }),
          provider: "ollama",
          model: "test-subagent",
          fallbackIndex: 0,
        };
      }) as unknown as typeof generateTextWithFallback,
    })) as { actions: Array<{ tool: string }> };
    const crawls = result.actions.filter((action) => action.tool === "crawl_page");
    expect(crawls.length).toBeGreaterThan(4);
    expect(result).toMatchObject({ mode: "component_specs" });
  });
});
