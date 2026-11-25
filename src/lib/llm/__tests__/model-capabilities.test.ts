import { describe, expect, it } from "vitest";
import {
  getFreeTierWarning,
  isGemini4Model,
  supportsGeminiReasoning,
  supportsGeminiThoughts,
  supportsReasoning
} from "../model-capabilities";

describe("isGemini4Model and supportsGeminiThoughts", () => {
  it("detects Gemini 4 text models and excludes media/live models", () => {
    expect(isGemini4Model("gemini-4-hydrogen")).toBe(true);
    expect(isGemini4Model("models/gemini-4.5-pro")).toBe(true);
    expect(isGemini4Model("gemini-4")).toBe(true);
    expect(isGemini4Model("gemini-4-image")).toBe(false);
    expect(isGemini4Model("gemini-3.5-flash")).toBe(false);
    expect(isGemini4Model("gemini-2.5-pro")).toBe(false);
  });

  it("supportsGeminiThoughts matches 4.x, 3.x, and 2.5 non-lite while supportsGeminiReasoning includes 2.5 Flash-Lite", () => {
    expect(supportsGeminiThoughts("gemini-4-hydrogen")).toBe(true);
    expect(supportsGeminiThoughts("gemini-3.5-flash-lite")).toBe(true);
    expect(supportsGeminiThoughts("gemini-2.5-pro")).toBe(true);
    expect(supportsGeminiThoughts("gemini-2.5-flash")).toBe(true);
    expect(supportsGeminiThoughts("gemini-2.5-flash-lite")).toBe(false);
    expect(supportsGeminiThoughts("gemini-2.0-flash")).toBe(false);

    expect(supportsGeminiReasoning("gemini-2.5-flash-lite")).toBe(true);
    expect(supportsGeminiReasoning("gemini-4-hydrogen")).toBe(true);
    expect(supportsGeminiReasoning("gemini-2.0-flash")).toBe(false);
    expect(supportsGeminiReasoning("gemini-embedding-2")).toBe(false);
  });
});

describe("supportsReasoning", () => {
  it("hides reasoning for Groq regardless of model ID", () => {
    expect(supportsReasoning("groq", "deepseek-r1-distill-llama-70b")).toBe(false);
    expect(supportsReasoning("groq", "qwen/qwen3-32b")).toBe(false);
    expect(supportsReasoning("groq", "openai/gpt-oss-120b")).toBe(false);
    expect(supportsReasoning("groq", "llama-3.3-70b-versatile")).toBe(false);
  });

  it("shows reasoning for thinking models across Gemini, OpenAI, Anthropic, DeepSeek, xAI, and OpenRouter", () => {
    expect(supportsReasoning("gemini", "gemini-4-hydrogen")).toBe(true);
    expect(supportsReasoning("gemini", "gemini-3.5-flash")).toBe(true);
    expect(supportsReasoning("gemini", "gemini-2.5-pro")).toBe(true);
    expect(supportsReasoning("gemini", "gemini-2.5-flash")).toBe(true);

    expect(supportsReasoning("openai", "o3")).toBe(true);
    expect(supportsReasoning("openai", "o4-mini")).toBe(true);
    expect(supportsReasoning("openai", "gpt-5")).toBe(true);
    expect(supportsReasoning("openai", "gpt-5.1-codex")).toBe(true);

    expect(supportsReasoning("anthropic", "claude-3-7-sonnet-20250219")).toBe(true);
    expect(supportsReasoning("anthropic", "claude-sonnet-4-20250514")).toBe(true);
    expect(supportsReasoning("anthropic", "claude-opus-4-5")).toBe(true);

    expect(supportsReasoning("deepseek", "deepseek-reasoner")).toBe(true);
    expect(supportsReasoning("openrouter", "deepseek/deepseek-r1:free")).toBe(true);
    expect(supportsReasoning("xai", "grok-3-mini")).toBe(true);
    expect(supportsReasoning("xai", "grok-4")).toBe(true);

    expect(
      supportsReasoning("openrouter", "vendor/custom-model", {
        supportedParameters: ["tools", "reasoning"]
      })
    ).toBe(true);
  });

  it("recognizes optional reasoning on Gemini 2.5 Flash-Lite and hides truly non-thinking models", () => {
    expect(supportsReasoning("gemini", "gemini-2.5-flash-lite")).toBe(true);
    expect(supportsReasoning("gemini", "gemini-2.0-flash")).toBe(false);
    expect(supportsReasoning("openai", "gpt-4o")).toBe(false);
    expect(supportsReasoning("openai", "gpt-4.1-mini")).toBe(false);
    expect(supportsReasoning("anthropic", "claude-3-5-sonnet-20241022")).toBe(false);
    expect(supportsReasoning("deepseek", "deepseek-chat")).toBe(false);
    expect(supportsReasoning("openrouter", "meta-llama/llama-3.3-70b-instruct:free")).toBe(false);
    expect(supportsReasoning("openrouter", "openrouter/free")).toBe(false);
  });
});

describe("getFreeTierWarning", () => {
  it("flags Groq with model-specific TPM limits where documented and qualified copy otherwise", () => {
    const oss120 = getFreeTierWarning("groq", "openai/gpt-oss-120b");
    expect(oss120).not.toBeNull();
    expect(oss120?.badge).toBe("8K TPM free limit");
    expect(oss120?.detail).toContain("8K");
    expect(oss120?.detail).toContain("15–25K");

    const safeguard = getFreeTierWarning("groq", "openai/gpt-oss-safeguard-20b");
    expect(safeguard?.badge).toBe("2K TPM free limit");
    expect(safeguard?.detail).toContain("2K");

    const other = getFreeTierWarning("groq", "llama-3.3-70b-versatile");
    expect(other?.badge).toBe("Low TPM free limit");
    expect(other?.detail).toMatch(/varies by model and org|vary by model and org/i);

    const providerLevel = getFreeTierWarning("groq");
    expect(providerLevel?.badge).toBe("Low TPM free limit");
    expect(providerLevel?.detail).toMatch(/varies by model and org|vary by model and org/i);
  });

  it("returns null for providers without that free-tier bottleneck", () => {
    expect(getFreeTierWarning("gemini", "gemini-3.5-flash")).toBeNull();
    expect(getFreeTierWarning("openrouter", "openrouter/free")).toBeNull();
  });
});
