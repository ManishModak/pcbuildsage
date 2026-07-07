import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../config";
import { consult } from "../tools/consult";
import type { SearchClient } from "../web-search";
import type { generateTextWithFallback } from "../llm-client";

const state = vi.hoisted(() => ({ auditCache: new Map<string, { verdict: string; checked_at: string }>() }));

vi.mock("../db", () => ({
  DEFAULT_DB_PATH: "mock-products.db",
  getDb: () => ({
    prepare: (sql: string) => {
      if (sql.includes("FROM audit_cache")) {
        return {
          get: (pair: string) => state.auditCache.get(pair)
        };
      }
      if (sql.includes("INTO audit_cache")) {
        return {
          run: (pair: string, verdict: string, checked_at: string) => state.auditCache.set(pair, { verdict, checked_at })
        };
      }
      return {
        get: () => undefined,
        run: () => undefined
      };
    }
  })
}));

function configWithMockDb() {
  state.auditCache.clear();
  return resolveConfig({ dbPath: "mock-products.db", llmChain: "ollama:test-model", subagentLlmChain: "ollama:test-subagent", searchProvider: "none" });
}

const searchClient: SearchClient = {
  async search() {
    return {
      provider: "duckduckgo",
      grounded: true,
      results: [{ title: "source", url: "https://example.com/source", snippet: "grounded snippet" }]
    };
  }
};

describe("consult", () => {
  it("sanitizes build_audit output so it cannot emit Tier-1-clearing verdicts", async () => {
    const result = await consult(
      { mode: "build_audit", parts: { cpu: "cpu", motherboard: "motherboard", ram: "ram", gpu: "gpu", psu: "psu" } },
      configWithMockDb(),
      {
        searchClient,
        logPath: "/tmp/pcbuildsage-consult-test.jsonl",
        generateText: async () =>
          ({
            text: JSON.stringify({
              findings: [
                { severity: "blocking", verdict: "pass", detail: "This pair is fully approved.", sources: ["https://example.com/source"] }
              ]
            }),
            provider: "ollama",
            model: "test-subagent",
            fallbackIndex: 0
          }) as unknown as Awaited<ReturnType<typeof generateTextWithFallback>>
      }
    );

    expect(result).toMatchObject({ mode: "build_audit", authority: "advisory_only" });
    const auditResult = result as { verdicts: Array<{ severity: string }> };
    const severities = auditResult.verdicts.map((verdict) => verdict.severity);
    expect(severities).not.toContain("blocking");
    expect(severities).not.toContain("pass");
    expect(severities.every((severity) => ["warning", "needs_verification", "ok"].includes(severity))).toBe(true);
  });

  it("runs uncached build_audit pairs concurrently", async () => {
    let activeSearches = 0;
    let maxActiveSearches = 0;
    const concurrentSearchClient: SearchClient = {
      async search() {
        activeSearches += 1;
        maxActiveSearches = Math.max(maxActiveSearches, activeSearches);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeSearches -= 1;
        return { provider: "duckduckgo", grounded: true, results: [] };
      }
    };

    await consult(
      { mode: "build_audit", parts: { cpu: "cpu", motherboard: "motherboard", ram: "ram", gpu: "gpu", psu: "psu" } },
      configWithMockDb(),
      {
        searchClient: concurrentSearchClient,
        logPath: "/tmp/pcbuildsage-consult-test.jsonl",
        generateText: async () =>
          ({
            text: JSON.stringify({ findings: [{ severity: "needs_verification", detail: "Check vendor notes.", sources: [] }] }),
            provider: "ollama",
            model: "test-subagent",
            fallbackIndex: 0
          }) as unknown as Awaited<ReturnType<typeof generateTextWithFallback>>
      }
    );

    expect(maxActiveSearches).toBeGreaterThan(1);
  });

  it("includes the validation error in the JSON retry prompt", async () => {
    const prompts: string[] = [];
    const result = await consult(
      { mode: "component_specs", name: "Mystery CPU", category: "cpu" },
      configWithMockDb(),
      {
        searchClient,
        logPath: "/tmp/pcbuildsage-consult-test.jsonl",
        generateText: async ({ prompt }) => {
          prompts.push(prompt ?? "");
          return {
            text: prompts.length === 1
              ? JSON.stringify({ specs: { brand: 12, model: "CPU", aliases: [] }, sources: [] })
              : JSON.stringify({ specs: { brand: "AMD", model: "CPU", aliases: [] }, sources: ["https://example.com/source"] }),
            provider: "ollama",
            model: "test-subagent",
            fallbackIndex: 0
          } as unknown as Awaited<ReturnType<typeof generateTextWithFallback>>;
        }
      }
    );

    expect(result).toMatchObject({ mode: "component_specs", specs: expect.objectContaining({ brand: "AMD" }) });
    expect(prompts[1]).toContain("Previous response failed JSON/schema validation:");
    expect(prompts[1]).toContain("brand");
  });
});
