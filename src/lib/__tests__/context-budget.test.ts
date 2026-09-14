import { describe, expect, it } from "vitest";
import {
  DEFAULT_FALLBACK_CONTEXT_LIMIT,
  estimateTokens,
  getModelContextLimit,
  parseContextLimitFromError,
  shouldTriggerCompaction
} from "../llm/context-budget";

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
});
