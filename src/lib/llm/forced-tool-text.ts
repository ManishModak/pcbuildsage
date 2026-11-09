import type { LanguageModelV4CallOptions, LanguageModelV4Middleware, LanguageModelV4StreamPart, LanguageModelV4ToolCall } from "@ai-sdk/provider";
import { generateId } from "ai";
import { leadingJson } from "../tools/lenient-input";

/**
 * Some OpenAI-compatible servers (AMD's Qwen3.8-Flash-Next; Nemotron on NIM at
 * times) ignore a forced tool_choice and write the call as text, e.g.
 * `[{"name":"present_build","parameters":{...}}]`. A text-only step ends the
 * AI SDK loop, so the turn stops with a validated build never presented.
 *
 * On forced steps only (tool choice `required` or a named tool), this
 * middleware holds the step's text back and, if no real tool call came,
 * turns a text call naming an offered tool into a real tool call; a step
 * forced to present_build gets an empty present_build call instead (see
 * emptyForcedCall). Otherwise the text is released unchanged. Forced steps aren't meant to show text,
 * so holding it costs the user nothing.
 */
export const forcedToolTextMiddleware: LanguageModelV4Middleware = {
  specificationVersion: "v4",
  wrapGenerate: async ({ doGenerate, params }) => {
    const result = await doGenerate();
    const allowed = forcedToolNames(params);
    if (!allowed || result.content.some((part) => part.type === "tool-call")) return result;
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    const calls = parseTextToolCalls(text, allowed) ?? emptyForcedCall(params);
    if (!calls) return result;
    return {
      ...result,
      content: [...result.content.filter((part) => part.type !== "text"), ...calls],
      finishReason: { unified: "tool-calls", raw: result.finishReason.raw }
    };
  },
  wrapStream: async ({ doStream, params }) => {
    const result = await doStream();
    const allowed = forcedToolNames(params);
    if (!allowed) return result;
    const held: LanguageModelV4StreamPart[] = [];
    let text = "";
    let sawToolCall = false;
    const stream = result.stream.pipeThrough(
      new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(part, controller) {
          if (part.type === "text-start" || part.type === "text-delta" || part.type === "text-end") {
            held.push(part);
            if (part.type === "text-delta") text += part.delta;
            return;
          }
          if (part.type === "tool-call") sawToolCall = true;
          if (part.type !== "finish") {
            controller.enqueue(part);
            return;
          }
          const calls = sawToolCall ? null : (parseTextToolCalls(text, allowed) ?? emptyForcedCall(params));
          const textParts = held.splice(0);
          if (calls) {
            for (const call of calls) controller.enqueue(call);
            controller.enqueue({ ...part, finishReason: { unified: "tool-calls", raw: part.finishReason.raw } });
            return;
          }
          for (const textPart of textParts) controller.enqueue(textPart);
          controller.enqueue(part);
        },
        flush(controller) {
          // A stream that ends without a finish part still releases its text.
          for (const textPart of held.splice(0)) controller.enqueue(textPart);
        }
      })
    );
    return { ...result, stream };
  }
};

/**
 * Tools whose empty call does the expected thing from turn state:
 * present_build with no builds presents every build validated this turn.
 */
const EMPTY_CALL_TOOLS = new Set(["present_build"]);

/**
 * The call a step forced to one of EMPTY_CALL_TOOLS gets when the model wrote
 * no usable call, e.g. a text validate_build on the last step (Lightning, r12
 * local-ai), so a validated build is still shown.
 */
function emptyForcedCall(params: LanguageModelV4CallOptions): LanguageModelV4ToolCall[] | null {
  const choice = params.toolChoice;
  if (choice?.type !== "tool" || !EMPTY_CALL_TOOLS.has(choice.toolName)) return null;
  return [{ type: "tool-call", toolCallId: `forced-${generateId()}`, toolName: choice.toolName, input: "{}" }];
}

/** Tool names a forced step may call, or null when the step isn't forced. */
function forcedToolNames(params: LanguageModelV4CallOptions): Set<string> | null {
  const choice = params.toolChoice;
  if (choice?.type === "tool") return new Set([choice.toolName]);
  if (choice?.type !== "required") return null;
  return new Set((params.tools ?? []).map((t) => t.name));
}

/** The text without a surrounding code fence or <tool_call> tags. */
function stripCallWrappers(text: string): string {
  return text
    .trim()
    .replace(/^```[\w-]*\s*/, "")
    .replace(/\s*```$/, "")
    .replace(/<\/?tool_call>/g, "")
    .trim();
}

/**
 * Parses a tool call written as text: a JSON object or array of objects with
 * `name` (or `function.name`) and `parameters` / `arguments` / `input`, or the
 * XML style `<function=name><parameter=key>value</parameter></function>`,
 * optionally inside a code fence or <tool_call> tags. The text must be only
 * the call(s): prose around one ("Don't run this example: {...}") makes it an
 * explanation, not a call. Returns null unless every call names an allowed tool.
 */
export function parseTextToolCalls(text: string, allowed: Set<string>): LanguageModelV4ToolCall[] | null {
  const body = stripCallWrappers(text);
  if (body.startsWith("<function=")) return parseXmlToolCalls(body, allowed);
  // Only stray closers (which leadingJson's repair drops) may follow the value.
  const parsed = leadingJson(body);
  if (!parsed || !/^[\s\]}]*$/.test(parsed.rest)) return null;
  const value = parsed.value;
  const items = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  if (items.length === 0) return null;
  const calls: LanguageModelV4ToolCall[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") return null;
    const raw = item as Record<string, unknown>;
    const fn = raw.function && typeof raw.function === "object" ? (raw.function as Record<string, unknown>) : undefined;
    const name = raw.name ?? fn?.name;
    if (typeof name !== "string" || !allowed.has(name)) return null;
    const args = raw.parameters ?? raw.arguments ?? raw.input ?? fn?.arguments ?? fn?.parameters ?? {};
    calls.push({ type: "tool-call", toolCallId: `text-${generateId()}`, toolName: name, input: typeof args === "string" ? args : JSON.stringify(args) });
  }
  return calls;
}

/**
 * Calls in the XML style Nemotron Lightning wrote as text on a forced step
 * (r29 esports): complete `<function=name>...</function>` blocks and nothing
 * else, each parameter a JSON value or, failing that, a string.
 */
function parseXmlToolCalls(body: string, allowed: Set<string>): LanguageModelV4ToolCall[] | null {
  const blocks = [...body.matchAll(/<function=([\w-]+)>([\s\S]*?)<\/function>/g)];
  if (blocks.length === 0 || body.replace(/<function=[\w-]+>[\s\S]*?<\/function>/g, "").trim() !== "") return null;
  const calls: LanguageModelV4ToolCall[] = [];
  for (const block of blocks) {
    const name = block[1];
    if (!allowed.has(name)) return null;
    const args: Record<string, unknown> = {};
    for (const param of block[2].matchAll(/<parameter=([\w-]+)>([\s\S]*?)<\/parameter>/g)) {
      const raw = param[2].trim();
      try {
        args[param[1]] = JSON.parse(raw);
      } catch {
        args[param[1]] = raw;
      }
    }
    calls.push({ type: "tool-call", toolCallId: `text-${generateId()}`, toolName: name, input: JSON.stringify(args) });
  }
  return calls;
}
