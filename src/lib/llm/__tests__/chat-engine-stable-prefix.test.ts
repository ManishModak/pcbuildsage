import { describe, expect, it, vi } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { MockLanguageModelV4 } from "ai/test";

// What the model receives at each step of a normal turn, through the real AI SDK loop.
const state = vi.hoisted(() => ({ requests: [] as Array<{ tools: string; system: string }>, script: [] as unknown[][] }));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: () => () =>
    new MockLanguageModelV4({
      doStream: async (options) => {
        state.requests.push({
          tools: JSON.stringify(options.tools ?? []),
          system: JSON.stringify(options.prompt.filter((message) => message.role === "system"))
        });
        const parts = state.script.shift() ?? [];
        const calls = parts.some((part) => (part as { type: string }).type === "tool-call");
        const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
        return {
          stream: new ReadableStream({
            start(controller) {
              for (const part of [{ type: "stream-start", warnings: [] }, ...parts]) controller.enqueue(part);
              controller.enqueue({ type: "finish", finishReason: { unified: calls ? "tool-calls" : "stop", raw: "x" }, usage });
              controller.close();
            }
          })
        } as never;
      }
    })
}));

vi.mock("@/lib/logger", () => ({ appendChatLog: vi.fn().mockResolvedValue(undefined) }));

import { resolveConfig } from "@/lib/config";
import { streamChat } from "../chat-engine";

const call = (id: string, toolName: string, input: unknown) => ({ type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) });
const text = (value: string) => [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: value }, { type: "text-end", id: "t" }];
const anyInput = z.object({}).passthrough();
const WHOLE_BUILD = [{ category: "cpu" }, { category: "motherboard" }, { category: "ram" }, { category: "storage" }, { category: "psu" }, { category: "case" }];

const tools = {
  search_products: tool({ description: "search", inputSchema: anyInput, execute: async () => ({ results: [] }) }),
  validate_build: tool({
    description: "validate",
    inputSchema: anyInput,
    execute: async () => ({ builds: { "Within budget": { valid: true, issues: [], snapshot: { label: "Within budget", components: WHOLE_BUILD } } } })
  }),
  present_build: tool({ description: "present", inputSchema: anyInput, execute: async () => ({ presented: true, buildCount: 1, builds: [{ label: "Within budget" }] }) }),
  suggest_followups: tool({ description: "followups", inputSchema: anyInput, execute: async () => ({ prompts: ["Add a GPU later"] }) })
};

describe("prompt prefix across a turn", () => {
  it("sends the same system prompt and tool list at every step of a normal turn", async () => {
    // Search, validate, present, then answer: the steps where the harness changes its directives.
    state.script = [
      [call("s1", "search_products", { category: "cpu" })],
      [call("v1", "validate_build", { builds: [] })],
      [call("p1", "present_build", { builds: [{ label: "Within budget" }] })],
      [...text("Here it is."), call("f1", "suggest_followups", { prompts: ["Add a GPU later"] })]
    ];
    const chain = [{ provider: "openai-compatible" as const, model: "m", baseUrl: "http://127.0.0.1:1/v1", keySource: "none" as const, contextLimit: 131072 }];
    const config = resolveConfig({ llmChain: chain, chatLlmChain: chain, subagentLlmChain: chain, dbPath: ":memory:", countryCode: "IN", currency: "INR", searchProvider: "none" });
    const result = await streamChat(config, [{ role: "user", content: "Office PC under ₹35,000" }], undefined, undefined, null, undefined, { tools });
    for await (const part of result.fullStream) void part;
    // A changed prefix makes a local server re-read the whole prompt (r32: ~20 s per re-read on Ornith).
    expect(state.requests).toHaveLength(4);
    expect(new Set(state.requests.map((r) => r.tools)).size).toBe(1);
    expect(new Set(state.requests.map((r) => r.system)).size).toBe(1);
  });
});
