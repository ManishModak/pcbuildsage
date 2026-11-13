import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";

// Only the provider factory is fake; streamText is the real installed SDK, so
// this proves the options actually reach the request.
const state = vi.hoisted(() => ({ requests: [] as Array<{ modelId: string; providerOptions: unknown }> }));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => (modelId: string) =>
    new MockLanguageModelV4({
      doStream: async (options) => {
        state.requests.push({ modelId, providerOptions: options.providerOptions });
        const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: "t" });
              controller.enqueue({ type: "text-delta", id: "t", delta: "ok" });
              controller.enqueue({ type: "text-end", id: "t" });
              controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
              controller.close();
            }
          })
        } as never;
      }
    })
}));

import { geminiThinkingOptions, streamTextWithFallback, supportsGeminiThoughts } from "@/lib/llm/client";

const entry = (model: string) => ({ provider: "gemini", model, keySource: "env" }) as never;

async function streamOnce(model: string) {
  const result = await streamTextWithFallback({
    chain: [entry(model)],
    messages: [{ role: "user", content: "hi" }],
    firstTokenTimeoutMs: 2_000
  });
  // Drain: the request is made when the first part arrives.
  const reader = result.fullStream.getReader();
  while (!(await reader.read()).done) {
    // Read to the end so the stream settles.
  }
  return state.requests.at(-1);
}

describe("Gemini thought summaries", () => {
  it.each([
    "gemini-4-hydrogen",
    "gemini-3.5-flash",
    "gemini-3-pro",
    // Gemini 3 Flash-Lite thinks ("minimal" by default) and returns summaries.
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash-lite",
    "models/gemini-2.5-pro"
  ])("asks for thoughts on %s", (model) => {
    expect(supportsGeminiThoughts(model)).toBe(true);
    expect(geminiThinkingOptions(entry(model))).toEqual({
      providerOptions: { google: { thinkingConfig: { includeThoughts: true } } }
    });
  });

  it.each([
    // 2.5 Flash-Lite does not think, so there is nothing to summarise.
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-4-image",
    "gemma-3-27b",
    "gemini-live-2.5-flash"
  ])("leaves %s alone", (model) => {
    expect(supportsGeminiThoughts(model)).toBe(false);
    expect(geminiThinkingOptions(entry(model))).toEqual({});
  });

  it("sends includeThoughts on the real stream request", async () => {
    const request = await streamOnce("gemini-4-hydrogen");
    expect(request?.modelId).toBe("gemini-4-hydrogen");
    expect(request?.providerOptions).toEqual({ google: { thinkingConfig: { includeThoughts: true } } });
  });

  it("sends no thinking options for a model that cannot think (2.5 Flash-Lite)", async () => {
    const request = await streamOnce("gemini-2.5-flash-lite");
    expect(request?.providerOptions).toBeUndefined();
  });
});
