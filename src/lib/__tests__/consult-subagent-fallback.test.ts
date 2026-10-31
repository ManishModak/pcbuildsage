import { describe, expect, it, vi } from "vitest";

// Real generateTextWithFallback, fake provider calls: entry 0 hangs until its
// signal aborts, entry 1 answers.
const calls = vi.hoisted(() => [] as string[]);

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: async (args: { model: { modelId: string }; abortSignal?: AbortSignal }) => {
      calls.push(args.model.modelId);
      if (args.model.modelId === "hung") {
        return new Promise((_, reject) => {
          args.abortSignal?.addEventListener("abort", () => reject(args.abortSignal?.reason), { once: true });
        });
      }
      return { text: JSON.stringify({ specs: { brand: "AMD", model: "Chip", aliases: [] }, sources: [] }), steps: [] };
    }
  };
});

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: () => (modelId: string) => ({ provider: "mock", modelId })
}));

vi.mock("../db", () => ({
  DEFAULT_DB_PATH: "mock-products.db",
  getDb: () => ({ prepare: () => ({ get: () => undefined, run: () => undefined }) })
}));

import { resolveConfig } from "../config";
import { consult } from "../tools/consult";

describe("research subagent fallback", () => {
  it("falls back to the next entry when entry 0 hangs past its per-entry timeout", async () => {
    const config = resolveConfig({ dbPath: "mock-products.db", llmChain: "ollama:test", subagentLlmChain: "ollama:hung,ollama:good", searchProvider: "none" });
    const result = (await consult({ mode: "component_specs", name: "Chip", category: "cpu" }, config, {
      logPath: "/tmp/pcbuildsage-test-subagent-fallback.jsonl",
      timeoutMsPerEntry: 50
    })) as { specs?: { brand: string }; error?: string };
    expect(calls).toEqual(["hung", "good"]);
    expect(result.error).toBeUndefined();
    expect(result.specs?.brand).toBe("AMD");
  });
});
