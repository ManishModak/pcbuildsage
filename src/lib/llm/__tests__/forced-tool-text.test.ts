import { describe, expect, it } from "vitest";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { forcedToolTextMiddleware, parseTextToolCalls } from "../forced-tool-text";

const tools = [
  { type: "function", name: "validate_build", inputSchema: {} },
  { type: "function", name: "present_build", inputSchema: {} }
] as LanguageModelV4CallOptions["tools"];
const finish = { type: "finish", usage: {} as never, finishReason: { unified: "stop", raw: "stop" } } as LanguageModelV4StreamPart;
const textParts = (text: string): LanguageModelV4StreamPart[] => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text.slice(0, 5) },
  { type: "text-delta", id: "t", delta: text.slice(5) },
  { type: "text-end", id: "t" }
];

async function runStream(parts: LanguageModelV4StreamPart[], toolChoice: LanguageModelV4CallOptions["toolChoice"]) {
  const stream = new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    }
  });
  const result = await forcedToolTextMiddleware.wrapStream!({
    doStream: async () => ({ stream }),
    doGenerate: async () => { throw new Error("unused"); },
    params: { prompt: [], tools, toolChoice } as LanguageModelV4CallOptions,
    model: {} as never
  });
  const out: LanguageModelV4StreamPart[] = [];
  const reader = result.stream.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) out.push(next.value);
  return out;
}

describe("tool calls written as text on forced steps", () => {
  // AMD's Qwen3.8-Flash-Next answers tool_choice "required" or a named tool this way.
  const qwenText = '[\n  {\n    "name": "present_build",\n    "parameters": {"builds": [{"label": "Within budget"}]}\n  }\n]';

  it("become real tool calls when the step is forced", async () => {
    const out = await runStream([...textParts(qwenText), finish], { type: "required" });
    expect(out.map((p) => p.type)).toEqual(["tool-call", "finish"]);
    expect(out[0]).toMatchObject({ toolName: "present_build", input: '{"builds":[{"label":"Within budget"}]}' });
    expect(out[1]).toMatchObject({ finishReason: { unified: "tool-calls" } });
  });

  it("must name the forced tool when one tool is forced", async () => {
    const out = await runStream([...textParts(qwenText), finish], { type: "tool", toolName: "validate_build" });
    expect(out.map((p) => p.type)).toEqual(["text-start", "text-delta", "text-delta", "text-end", "finish"]);
  });

  it("send an empty present_build call when a step forced to it gets no usable call", async () => {
    const textValidate = "<tool_call> <function=validate_build> <parameter=builds> [] </parameter> </function> </tool_call>";
    const out = await runStream([...textParts(textValidate), finish], { type: "tool", toolName: "present_build" });
    expect(out.map((p) => p.type)).toEqual(["tool-call", "finish"]);
    expect(out[0]).toMatchObject({ toolName: "present_build", input: "{}" });
    // Other forced tools still release the text.
    const validateForced = await runStream([...textParts("I will validate now."), finish], { type: "tool", toolName: "validate_build" });
    expect(validateForced.map((p) => p.type)).toEqual(["text-start", "text-delta", "text-delta", "text-end", "finish"]);
  });

  it("leave unforced steps and real tool calls alone", async () => {
    expect((await runStream([...textParts(qwenText), finish], { type: "auto" })).map((p) => p.type)).toEqual(["text-start", "text-delta", "text-delta", "text-end", "finish"]);
    const real = { type: "tool-call", toolCallId: "c1", toolName: "validate_build", input: "{}" } as LanguageModelV4StreamPart;
    const out = await runStream([real, ...textParts(qwenText), finish], { type: "required" });
    expect(out.filter((p) => p.type === "tool-call")).toEqual([real]);
    expect(out.at(-1)).toEqual(finish);
  });

  it("parse objects, function-style calls, fenced text and string arguments, but not unknown tools or prose", () => {
    const allowed = new Set(["validate_build"]);
    expect(parseTextToolCalls('```json\n{"name":"validate_build","arguments":"{\\"budget\\":1}"}\n```', allowed)?.[0]).toMatchObject({ toolName: "validate_build", input: '{"budget":1}' });
    expect(parseTextToolCalls('<tool_call>{"function":{"name":"validate_build","arguments":{"budget":2}}}</tool_call>', allowed)?.[0]).toMatchObject({ input: '{"budget":2}' });
    expect(parseTextToolCalls('[{"name":"search_products","parameters":{}}]', allowed)).toBeNull();
    expect(parseTextToolCalls("Here is your build.", allowed)).toBeNull();
  });

  it("parses the XML style of text tool call", () => {
    const allowed = new Set(["validate_build", "present_build"]);
    const text = '<tool_call>\n<function=present_build>\n<parameter=builds>\n[{"label": "Within budget", "product_ids": ["85f79e17e6"]}]\n</parameter>\n<parameter=note>plain text</parameter>\n</function>\n</tool_call>\n';
    expect(parseTextToolCalls(text, allowed)).toEqual([
      expect.objectContaining({ toolName: "present_build", input: '{"builds":[{"label":"Within budget","product_ids":["85f79e17e6"]}],"note":"plain text"}' })
    ]);
    expect(parseTextToolCalls("<function=search_products><parameter=category>cpu</parameter></function>", allowed)).toBeNull();
    // An unfinished block isn't a call.
    expect(parseTextToolCalls('<function=present_build><parameter=builds>[]</parameter>', allowed)).toBeNull();
  });

  it("ignore a call quoted inside prose", () => {
    const allowed = new Set(["validate_build", "present_build"]);
    expect(parseTextToolCalls('Do not run this example: {"name":"present_build","parameters":{}}. I need to replace that build.', allowed)).toBeNull();
    expect(parseTextToolCalls('{"name":"present_build","parameters":{}} is what I would call next.', allowed)).toBeNull();
    expect(parseTextToolCalls("For example <function=present_build></function> presents it.", allowed)).toBeNull();
    expect(parseTextToolCalls('{"name":"validate_build","parameters":{}} Do not execute this example; wait for {"motherboard":"chosen"}', allowed)).toBeNull();
    // A stray closer after the call (Lightning's "[{...}]}") is still a call.
    expect(parseTextToolCalls('[{"name":"validate_build","parameters":{}}]}', allowed)).toHaveLength(1);
  });
});
