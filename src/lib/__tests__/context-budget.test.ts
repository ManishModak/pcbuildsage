import { describe, expect, it } from "vitest";
import {
  DEFAULT_FALLBACK_CONTEXT_LIMIT,
  TOOL_DEFINITIONS_TOKEN_OVERHEAD,
  estimateTokens,
  getModelContextLimit,
  parseContextLimitFromError,
  shouldTriggerCompaction,
  measureToolDefinitionsTokens,
  calculateStepTokens
} from "../llm/context-budget";
import { createToolRegistry } from "../tools";
import type { AppConfig } from "@/types";

describe("context-budget", () => {
  describe("estimateTokens", () => {
    it("returns 0 for empty or null content", () => {
      expect(estimateTokens(null)).toBe(0);
      expect(estimateTokens(undefined)).toBe(0);
      expect(estimateTokens("")).toBe(0);
    });

    it("estimates token count proportionally from characters", () => {
      const text = "Hello world, this is a test prompt for token estimation.";
      const count = estimateTokens(text);
      expect(count).toBeGreaterThan(5);
      expect(count).toBeLessThan(30);
    });

    it("estimates token count from arrays and structured objects", () => {
      const messages = [
        { role: "user", content: "Recommend a gaming GPU" },
        { role: "assistant", content: "I recommend the RTX 4070." }
      ];
      const count = estimateTokens(messages);
      expect(count).toBeGreaterThan(15);
    });
  });

  describe("parseContextLimitFromError", () => {
    it("parses OpenAI-compatible context limit errors", () => {
      const err = new Error(
        "This model's maximum context length is 8192 tokens. However, your messages resulted in 9100 tokens."
      );
      expect(parseContextLimitFromError(err)).toBe(8192);
    });

    it("parses Ollama context window error messages", () => {
      const err = new Error("model requires context window of 4,096 tokens");
      expect(parseContextLimitFromError(err)).toBe(4096);
    });

    it("parses Groq context length errors", () => {
      const err = { message: "context length is 131072 tokens" };
      expect(parseContextLimitFromError(err)).toBe(131072);
    });

    it("parses JSON-like error attributes", () => {
      const err = new Error('{"error": {"code": 400, "context_length": 32768}}');
      expect(parseContextLimitFromError(err)).toBe(32768);
    });

    it("returns undefined for non-context errors", () => {
      expect(parseContextLimitFromError(new Error("503 Service Unavailable"))).toBeUndefined();
      expect(parseContextLimitFromError(new Error("Invalid API key"))).toBeUndefined();
      expect(parseContextLimitFromError(null)).toBeUndefined();
    });
  });

  describe("getModelContextLimit", () => {
    it("returns configuredLimit when provided", () => {
      expect(getModelContextLimit("llama3", "ollama", 8192)).toBe(8192);
      expect(getModelContextLimit("gpt-4o", "openai", 128000)).toBe(128000);
    });

    it("resolves known models from registry when configured limit is not provided", () => {
      expect(getModelContextLimit("nex-agi/nex-n2.5-mini:free")).toBe(262144);
      expect(getModelContextLimit({ model: "nex-agi/nex-n2.5-mini:free" })).toBe(262144);
      expect(getModelContextLimit({ model: "nex-agi/nex-n2.5-mini", provider: "openrouter" })).toBe(262144);
      expect(getModelContextLimit("anthropic/claude-3.5-sonnet")).toBe(200000);
      expect(getModelContextLimit("google/gemini-2.5-flash")).toBe(1048576);
    });

    it("prefers explicit contextLimit on entry object over known model registry", () => {
      expect(getModelContextLimit({ model: "nex-agi/nex-n2.5-mini:free", contextLimit: 65536 })).toBe(65536);
    });

    it("falls back to explicit conservative 32,768 tokens without regex guessing", () => {
      expect(getModelContextLimit("unknown-model", "custom-proxy")).toBe(DEFAULT_FALLBACK_CONTEXT_LIMIT);
      expect(getModelContextLimit("deepseek-r1", "ollama")).toBe(32768);
      expect(getModelContextLimit()).toBe(32768);
    });
  });

  describe("shouldTriggerCompaction", () => {
    const limit = 32768;

    it("returns false below 78% usage and far from reserve threshold", () => {
      expect(shouldTriggerCompaction(10000, limit)).toBe(false);
      expect(shouldTriggerCompaction(25000, limit)).toBe(false); // 25000 / 32768 = ~76.2%
    });

    it("returns true at or above 78% usage", () => {
      const threshold78 = Math.ceil(limit * 0.78);
      expect(shouldTriggerCompaction(threshold78, limit)).toBe(true);
      expect(shouldTriggerCompaction(threshold78 + 500, limit)).toBe(true);
    });

    it("returns true when remaining headroom is less than reserved output tokens", () => {
      const smallLimit = 8192;
      // 8192 - 4096 = 4096 tokens
      expect(shouldTriggerCompaction(4100, smallLimit)).toBe(true);
    });

    it("returns false for invalid or zero context limits", () => {
      expect(shouldTriggerCompaction(1000, 0)).toBe(false);
      expect(shouldTriggerCompaction(1000, -1)).toBe(false);
    });
  });

  describe("measureToolDefinitionsTokens", () => {
    const baseConfig: AppConfig = {
      dbPath: ":memory:",
      countryCode: "US",
      currency: "USD",
      personality: "balanced",
      theme: "sage-dark",
      tier2Enabled: false,
      freeformConsultEnabled: false,
      llm: { chain: [], roles: { chat: [], subagent: [], scraper: [] } },
      search: { provider: "none", crawlEnabled: false }
    };

    it("measures tool definitions from actual schemas instead of hardcoded 1200", () => {
      const tools = createToolRegistry(baseConfig);
      const measured = measureToolDefinitionsTokens(tools);
      // Actual schemas for search_products, list_models, validate_build, etc. total > 4000 tokens
      expect(measured).toBeGreaterThan(4000);
      expect(measured).not.toBe(TOOL_DEFINITIONS_TOKEN_OVERHEAD);
    });

    it("increases measured token overhead when additional tools (e.g. consult) are present", () => {
      const standardTools = createToolRegistry(baseConfig);
      const withConsultTools = createToolRegistry({
        ...baseConfig,
        tier2Enabled: true,
        search: { provider: "duckduckgo", crawlEnabled: false }
      });

      const standardOverhead = measureToolDefinitionsTokens(standardTools);
      const consultOverhead = measureToolDefinitionsTokens(withConsultTools);
      expect(consultOverhead).toBeGreaterThan(standardOverhead);
    });

    it("handles null, undefined, or empty tool registry gracefully", () => {
      expect(measureToolDefinitionsTokens(null)).toBe(TOOL_DEFINITIONS_TOKEN_OVERHEAD);
      expect(measureToolDefinitionsTokens(undefined)).toBe(TOOL_DEFINITIONS_TOKEN_OVERHEAD);
      expect(measureToolDefinitionsTokens({})).toBe(0);
    });
  });

  describe("calculateStepTokens", () => {
    it("falls back to characters ÷ 3.5 calculation when there is no usage data", () => {
      const text = "A".repeat(350); // 350 / 3.5 = 100 tokens
      const messages = [{ role: "user", content: text }];
      const count = calculateStepTokens({
        currentMessages: messages,
        systemPrompt: "System",
        toolsOverhead: 500
      });
      // 100 (text) + 4 (array struct) + 2 (System/3.5 ceil) + 500 (tools)
      expect(count).toBeGreaterThanOrEqual(600);
      expect(count).toBeLessThan(700);
    });

    it("uses previous step provider-reported input tokens plus estimate of only new content", () => {
      const steps = [
        {
          usage: { inputTokens: 5000, outputTokens: 200 },
          text: "Here is your recommendation",
          toolCalls: [],
          toolResults: [{ toolCallId: "call-1", output: { result: "ok" } }]
        }
      ];

      const count = calculateStepTokens({
        steps,
        currentMessages: [{ role: "user", content: "Short message" }],
        systemPrompt: "System prompt",
        toolsOverhead: 1200
      });

      // Must be based on 5000 reported tokens + new content tokens, NOT full characters fallback
      expect(count).toBeGreaterThan(5000);
      expect(count).toBeLessThan(5500);
    });

    it("fires compaction at the real 78% with mocked model reporting usage, even when characters ÷ 3.5 would say 60%", () => {
      const contextLimit = 32_768;
      // 60% of 32,768 = ~19,660 tokens
      // 78% of 32,768 = ~25,559 tokens
      const tokens60 = Math.floor(contextLimit * 0.60);
      const tokens78 = Math.ceil(contextLimit * 0.78);

      // Character-based text sized to ~60% (19,660 * 3.5 = 68,810 characters)
      const mockContent = "X".repeat(Math.floor(tokens60 * 3.5));
      const messages = [{ role: "user", content: mockContent }];

      // Without provider usage, characters ÷ 3.5 yields ~60%
      const fallbackTokens = calculateStepTokens({
        currentMessages: messages,
        systemPrompt: "",
        toolsOverhead: 0
      });
      const ratioFallback = fallbackTokens / contextLimit;
      expect(ratioFallback).toBeCloseTo(0.60, 1);
      // Compaction would NOT fire with fallback:
      expect(shouldTriggerCompaction(fallbackTokens, contextLimit)).toBe(false);

      // With mocked model reporting usage of 78% real usage:
      const mockedSteps = [
        {
          usage: { inputTokens: tokens78, outputTokens: 10 },
          text: "Done",
          toolCalls: [],
          toolResults: []
        }
      ];

      const realTokens = calculateStepTokens({
        steps: mockedSteps,
        currentMessages: messages,
        systemPrompt: "",
        toolsOverhead: 0
      });

      // Uses the real reported usage (tokens78) + new content estimate
      expect(realTokens).toBeGreaterThanOrEqual(tokens78);
      const ratioReal = realTokens / contextLimit;
      expect(ratioReal).toBeGreaterThanOrEqual(0.78);

      // Compaction FIRES at the real 78%!
      expect(shouldTriggerCompaction(realTokens, contextLimit)).toBe(true);
    });
  });
});
