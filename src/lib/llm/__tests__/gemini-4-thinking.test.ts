import { describe, expect, it, vi, beforeEach } from "vitest";

const aiState = vi.hoisted(() => ({
  streamCalls: [] as Array<Record<string, unknown>>,
  generateCalls: [] as Array<Record<string, unknown>>
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: (args: Record<string, unknown>) => {
      aiState.streamCalls.push(args);
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", text: "ok" };
        })()
      };
    },
    generateText: async (args: Record<string, unknown>) => {
      aiState.generateCalls.push(args);
      return { text: "ok", steps: [] };
    }
  };
});

import { generateTextWithFallback, streamTextWithFallback } from "@/lib/llm/client";

const geminiEntry = (model: string, reasoningEffort?: "low" | "medium" | "high") =>
  ({
    provider: "gemini",
    model,
    keySource: "env",
    ...(reasoningEffort ? { reasoningEffort } : {})
  }) as never;

describe("Gemini 4 thinkingLevel options", () => {
  beforeEach(() => {
    aiState.streamCalls.length = 0;
    aiState.generateCalls.length = 0;
  });

  it.each(["low", "medium", "high"] as const)(
    "passes thinkingLevel %s without top-level reasoning on gemini-4 in streamTextWithFallback",
    async (effort) => {
      await streamTextWithFallback({
        chain: [geminiEntry("gemini-4-hydrogen", effort)],
        messages: [{ role: "user", content: "hi" }],
        firstTokenTimeoutMs: 2_000
      });
      const call = aiState.streamCalls[0];
      expect(call).toBeDefined();
      expect("reasoning" in call).toBe(false);
      expect(call.providerOptions).toEqual({
        google: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: effort
          }
        }
      });
      const googleConfig = (call.providerOptions as { google: { thinkingConfig: Record<string, unknown> } }).google.thinkingConfig;
      expect("thinkingBudget" in googleConfig).toBe(false);
    }
  );

  it.each(["low", "medium", "high"] as const)(
    "passes thinkingLevel %s without top-level reasoning on gemini-4 in generateTextWithFallback",
    async (effort) => {
      await generateTextWithFallback({
        chain: [geminiEntry("models/gemini-4-pro", effort)],
        prompt: "hi",
        timeoutMsPerEntry: 2_000
      });
      const call = aiState.generateCalls[0];
      expect(call).toBeDefined();
      expect("reasoning" in call).toBe(false);
      expect(call.providerOptions).toEqual({
        google: {
          thinkingConfig: {
            thinkingLevel: effort
          }
        }
      });
      const googleConfig = (call.providerOptions as { google: { thinkingConfig: Record<string, unknown> } }).google.thinkingConfig;
      expect("thinkingBudget" in googleConfig).toBe(false);
      expect("includeThoughts" in googleConfig).toBe(false);
    }
  );

  it("omits both reasoning and thinkingLevel when gemini-4 has no reasoningEffort, keeping includeThoughts on streams", async () => {
    await streamTextWithFallback({
      chain: [geminiEntry("gemini-4-hydrogen")],
      messages: [{ role: "user", content: "hi" }],
      firstTokenTimeoutMs: 2_000
    });
    expect("reasoning" in aiState.streamCalls[0]).toBe(false);
    expect(aiState.streamCalls[0].providerOptions).toEqual({
      google: { thinkingConfig: { includeThoughts: true } }
    });

    await generateTextWithFallback({
      chain: [geminiEntry("gemini-4-hydrogen")],
      prompt: "hi",
      timeoutMsPerEntry: 2_000
    });
    expect("reasoning" in aiState.generateCalls[0]).toBe(false);
    expect(aiState.generateCalls[0].providerOptions).toBeUndefined();
  });

  it("keeps existing top-level reasoning and includeThoughts behavior for gemini-3 and gemini-2.5", async () => {
    await streamTextWithFallback({
      chain: [geminiEntry("gemini-3.5-flash", "medium")],
      messages: [{ role: "user", content: "hi" }],
      firstTokenTimeoutMs: 2_000
    });
    expect(aiState.streamCalls[0].reasoning).toBe("medium");
    expect(aiState.streamCalls[0].providerOptions).toEqual({
      google: { thinkingConfig: { includeThoughts: true } }
    });

    await generateTextWithFallback({
      chain: [geminiEntry("gemini-2.5-pro", "low")],
      prompt: "hi",
      timeoutMsPerEntry: 2_000
    });
    expect(aiState.generateCalls[0].reasoning).toBe("low");
    expect(aiState.generateCalls[0].providerOptions).toBeUndefined();
  });

  it("never sends reasoning or thinkingConfig for non-text gemini-4 image models", async () => {
    await streamTextWithFallback({
      chain: [geminiEntry("gemini-4-image", "high")],
      messages: [{ role: "user", content: "hi" }],
      firstTokenTimeoutMs: 2_000
    });
    expect("reasoning" in aiState.streamCalls[0]).toBe(false);
    expect(aiState.streamCalls[0].providerOptions).toBeUndefined();
  });

  it("preserves explicit reasoning on gemini-2.5-flash-lite and keeps Gemini 4 thinkingLevel when thinking:false is set", async () => {
    await generateTextWithFallback({
      chain: [geminiEntry("gemini-2.5-flash-lite", "high")],
      prompt: "hi",
      timeoutMsPerEntry: 2_000
    });
    expect(aiState.generateCalls[0].reasoning).toBe("high");

    await streamTextWithFallback({
      chain: [geminiEntry("gemini-4-hydrogen", "low")],
      messages: [{ role: "user", content: "hi" }],
      thinking: false,
      firstTokenTimeoutMs: 2_000
    });
    expect("reasoning" in aiState.streamCalls[0]).toBe(false);
    expect(aiState.streamCalls[0].providerOptions).toEqual({
      google: { thinkingConfig: { thinkingLevel: "low" } }
    });
  });
});
