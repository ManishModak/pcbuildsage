import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";

// Real streamText from the installed AI SDK; only the provider model is fake.
const modelState = vi.hoisted(() => ({ models: [] as unknown[] }));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: () => () => modelState.models.shift()
}));

import { streamTextWithFallback } from "@/lib/llm/client";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

/**
 * A model whose stream emits `parts` and then stays open (like a slow
 * provider mid-answer). Records the request signal.
 */
function hangingModel(parts: unknown[]) {
  const seen: { signal?: AbortSignal } = {};
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      seen.signal = options.abortSignal;
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of [{ type: "stream-start", warnings: [] }, ...parts]) controller.enqueue(part);
          }
        })
      } as never;
    }
  });
  return { model, seen };
}

const chain = [
  { provider: "ollama", model: "a", keySource: "none" },
  { provider: "ollama", model: "b", keySource: "none" }
] as never[];

describe("streamTextWithFallback with the real SDK", () => {
  it("user Stop after the first token aborts the model request", async () => {
    const { model, seen } = hangingModel([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Hel" }]);
    modelState.models = [model];
    const controller = new AbortController();
    const result = await streamTextWithFallback({ chain, messages: [{ role: "user", content: "hi" }], abortSignal: controller.signal, firstTokenTimeoutMs: 1000 });
    const reader = result.fullStream.getReader();
    let part = await reader.read();
    while (!part.done && part.value.type !== "text-delta") part = await reader.read();
    expect(part.value).toMatchObject({ type: "text-delta", text: "Hel" });
    expect(seen.signal?.aborted).toBe(false);
    controller.abort();
    expect(seen.signal?.aborted).toBe(true);
    await reader.cancel();
  });

  it.each([
    ["text-start", [{ type: "text-start", id: "t" }]],
    ["reasoning-start", [{ type: "reasoning-start", id: "r" }]],
    ["tool-input-start", [{ type: "tool-input-start", id: "c", toolName: "search_products" }]]
  ])("counts %s as the first token (no fallback while the model is producing)", async (_label, parts) => {
    const first = hangingModel(parts);
    const second = hangingModel([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "x" }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }]);
    modelState.models = [first.model, second.model];
    const result = await streamTextWithFallback({ chain, messages: [{ role: "user", content: "hi" }], firstTokenTimeoutMs: 100 });
    expect(result).toMatchObject({ model: "a", fallbackIndex: 0 });
    await result.fullStream.cancel();
  });
});
