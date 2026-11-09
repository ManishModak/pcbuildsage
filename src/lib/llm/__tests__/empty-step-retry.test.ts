import { describe, expect, it } from "vitest";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { emptyStepRetryMiddleware } from "../empty-step-retry";

const finish = { type: "finish", usage: {} as never, finishReason: { unified: "stop", raw: "stop" } } as LanguageModelV4StreamPart;
const start = { type: "stream-start", warnings: [] } as LanguageModelV4StreamPart;
const reasoning: LanguageModelV4StreamPart[] = [
  { type: "reasoning-start", id: "r" },
  { type: "reasoning-delta", id: "r", delta: "thinking" },
  { type: "reasoning-end", id: "r" }
];
const call = { type: "tool-call", toolCallId: "c1", toolName: "search_products", input: "{}" } as LanguageModelV4StreamPart;
const blankText: LanguageModelV4StreamPart[] = [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "\n " },
  { type: "text-end", id: "t" }
];

function streamOf(parts: LanguageModelV4StreamPart[]) {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    }
  });
}

/** Runs the middleware over a model that answers with each response in turn. */
async function runStream(responses: LanguageModelV4StreamPart[][]) {
  let calls = 0;
  const result = await emptyStepRetryMiddleware.wrapStream!({
    doStream: async () => ({ stream: streamOf(responses[calls++] ?? []) }),
    doGenerate: async () => { throw new Error("unused"); },
    params: { prompt: [] } as LanguageModelV4CallOptions,
    model: {} as never
  });
  const out: LanguageModelV4StreamPart[] = [];
  const reader = result.stream.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) out.push(next.value);
  return { types: out.map((p) => p.type), calls };
}

describe("empty step retry", () => {
  it("asks again once when a step has no text and no tool call", async () => {
    const { types, calls } = await runStream([[start, ...reasoning, ...blankText, finish], [start, call, finish]]);
    expect(calls).toBe(2);
    expect(types).toEqual(["stream-start", "reasoning-start", "reasoning-delta", "reasoning-end", "text-start", "text-delta", "text-end", "tool-call", "finish"]);
  });

  it("passes a second empty answer through", async () => {
    const { types, calls } = await runStream([[start, finish], [start, finish], [start, call, finish]]);
    expect(calls).toBe(2);
    expect(types).toEqual(["stream-start", "finish"]);
  });

  it("leaves steps with a tool call or text alone", async () => {
    expect(await runStream([[start, call, finish]])).toMatchObject({ calls: 1, types: ["stream-start", "tool-call", "finish"] });
    const text: LanguageModelV4StreamPart = { type: "text-delta", id: "t", delta: "Here is your build" };
    expect(await runStream([[start, text, finish]])).toMatchObject({ calls: 1, types: ["stream-start", "text-delta", "finish"] });
  });
});
