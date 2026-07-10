import { generateText, streamText, tool, type AsyncIterableStream, type LanguageModel, type ModelMessage, type StopCondition, type StreamTextResult, type TextStreamPart, type ToolSet } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import type { LLMChainEntry, LLMProvider, LLMRole } from "./config-types";

export type ServedText<T = unknown> = T & {
  provider: LLMProvider;
  model: string;
  fallbackIndex: number;
  errors?: unknown[];
};

export function normalizeBaseUrl(input: string, provider: "ollama" | "openai-compatible" = "openai-compatible"): string {
  let value = input.trim();
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  value = value.replace(/\/+$/, "");
  const url = new URL(value);
  if (provider === "ollama") return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`.replace(/\/+$/, "");
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname === "" || pathname === "/" ? "/v1" : pathname;
  return url.toString().replace(/\/+$/, "");
}

export function createLanguageModel(entry: LLMChainEntry): LanguageModel {
  if (entry.provider === "gemini") {
    return createGoogleGenerativeAI({ apiKey: resolveApiKey(entry, "GEMINI_API_KEY") })(entry.model);
  }

  const baseURL = normalizeBaseUrl(entry.baseUrl ?? defaultBaseUrl(entry.provider), entry.provider === "ollama" ? "ollama" : "openai-compatible");
  const apiKey = resolveApiKey(entry, keyEnv(entry.provider)) || (entry.keySource === "none" ? "pcbuildsage-keyless" : undefined);
  // Ollama is reached through its OpenAI-compatible /v1 endpoint; there is no first-party @ai-sdk/ollama dependency here.
  return createOpenAICompatible({ name: entry.provider, baseURL: entry.provider === "ollama" ? appendV1(baseURL) : baseURL, apiKey, includeUsage: true })(entry.model) as unknown as LanguageModel;
}

function appendV1(baseURL: string): string {
  return baseURL.replace(/\/v1\/?$/i, "").replace(/\/+$/, "") + "/v1";
}

export async function generateTextWithFallback(args: {
  chain: LLMChainEntry[];
  role?: LLMRole;
  prompt?: string;
  system?: string;
  messages?: Parameters<typeof generateText>[0]["messages"];
  tools?: ToolSet;
  stopWhen?: Parameters<typeof generateText>[0]["stopWhen"];
}) {
  const errors: unknown[] = [];
  for (const [index, entry] of args.chain.entries()) {
    try {
      const prompt = args.messages
        ? { messages: args.messages }
        : { prompt: args.prompt ?? "" };
      const result = await generateText({
        model: createLanguageModel(entry),
        ...prompt,
        system: args.system,
        tools: args.tools,
        stopWhen: args.stopWhen,
        maxRetries: 0
      });
      return Object.assign(result, { provider: entry.provider, model: entry.model, fallbackIndex: index }) as ServedText<typeof result>;
    } catch (error) {
      if (!isFallbackable(error)) throw error;
      errors.push(error);
    }
  }
  throw new AggregateError(errors, "All fallback LLM providers failed.");
}

export async function streamTextWithFallback(args: {
  chain: LLMChainEntry[];
  system?: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  maxSteps?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stopWhen?: StopCondition<any> | Array<StopCondition<any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onStepFinish?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onFinish?: any;
}) {
  if (!args.chain.length) throw new Error("LLM chain is empty.");
  const errors: unknown[] = [];
  for (const [index, entry] of args.chain.entries()) {
    try {
      const result = streamText({
        ...args,
        model: createLanguageModel(entry),
        maxRetries: 0
      });
      const started = await probeStarted(result);
      return withServedStreams(result, started.fullStream, entry, index, errors);
    } catch (error) {
      if (!isFallbackable(error)) throw error;
      errors.push(error);
    }
  }
  throw new AggregateError(errors, "All fallback LLM providers failed before streaming content.");
}

export async function probeToolCapability(entry: LLMChainEntry): Promise<{ ok: boolean; remedies?: string[]; error?: string }> {
  try {
    await generateText({
      model: createLanguageModel(entry),
      prompt: "Call the ping tool once.",
      tools: {
        ping: tool({
          description: "Small setup probe. Use when asked to call it.",
          inputSchema: z.object({ value: z.string().describe("Any short value to echo.") }),
          execute: async ({ value }) => ({ value })
        })
      },
      stopWhen: ({ steps }) => steps.length >= 2,
      maxRetries: 0
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      remedies: ["Enable tool calling on the backend launch flags or model template.", "Switch to a model that supports native tool calling."]
    };
  }
}

export function isFallbackable(error: unknown): boolean {
  const status = statusFromError(error);
  if (status === 401 || status === 403) return false;
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return [
    "timeout",
    "timed out",
    "network",
    "fetch failed",
    "econnreset",
    "enotfound",
    "econnrefused",
    "429",
    "rate limit",
    "too many requests",
    "quota exceeded",
    "502",
    "503",
    "504"
  ].some((needle) => message.includes(needle));
}

function statusFromError(error: unknown): number | undefined {
  if (typeof error === "object" && error) {
    const maybe = error as { statusCode?: unknown; status?: unknown; response?: { status?: unknown } };
    const status = maybe.statusCode ?? maybe.status ?? maybe.response?.status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

export function resolveApiKey(entry: LLMChainEntry, envKey: string): string | undefined {
  if (entry.keySource === "none") return undefined;
  return entry.apiKey ?? process.env[envKey];
}

export function keyEnv(provider: LLMProvider): string {
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  if (provider === "gemini") return "GEMINI_API_KEY";
  if (provider === "ollama") return "OLLAMA_API_KEY";
  return "OPENAI_COMPATIBLE_API_KEY";
}

function defaultBaseUrl(provider: LLMProvider): string {
  if (provider === "ollama") return process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  if (provider === "openrouter") return "https://openrouter.ai/api/v1";
  return process.env.OPENAI_COMPATIBLE_BASE_URL ?? "http://localhost:8000/v1";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function probeStarted(result: StreamTextResult<ToolSet, any, any>): Promise<{ fullStream: AsyncIterableStream<TextStreamPart<ToolSet>> }> {
  const iterator = result.fullStream[Symbol.asyncIterator]();
  const buffer: TextStreamPart<ToolSet>[] = [];

  while (true) {
    const next = await iterator.next();
    if (next.done) {
      break;
    }
    const part = next.value;
    buffer.push(part);

    if (part.type === "error") {
      throw part.error;
    }

    if (
      part.type === "text-delta" ||
      part.type === "tool-call" ||
      part.type === "reasoning-delta" ||
      part.type === "finish" ||
      part.type === "finish-step" ||
      part.type === "tool-result"
    ) {
      break;
    }
  }

  return {
    fullStream: iterableToStream(async function* () {
      for (const item of buffer) {
        yield item;
      }
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        const part = next.value;
        if (part.type === "error") throw part.error;
        yield part;
      }
    })
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withServedStreams(
  result: StreamTextResult<ToolSet, any, any>,
  fullStream: AsyncIterableStream<TextStreamPart<ToolSet>>,
  entry: LLMChainEntry,
  fallbackIndex: number,
  errors?: unknown[]
) {
  const [fullForResult, fullForText] = fullStream.tee();
  const textStream = fullForText.pipeThrough(new TransformStream<TextStreamPart<ToolSet>, string>({
    transform(part, controller) {
      if (part.type === "text-delta") controller.enqueue(part.text);
    }
  })) as AsyncIterableStream<string>;
  const served = Object.create(result) as ServedText<typeof result>;
  Object.defineProperties(served, {
    fullStream: { value: fullForResult as AsyncIterableStream<TextStreamPart<ToolSet>>, enumerable: true },
    textStream: { value: textStream, enumerable: true },
    provider: { value: entry.provider, enumerable: true },
    model: { value: entry.model, enumerable: true },
    fallbackIndex: { value: fallbackIndex, enumerable: true },
    errors: { value: errors, enumerable: true }
  });
  return served;
}

function iterableToStream<T>(factory: () => AsyncIterable<T>): AsyncIterableStream<T> {
  return new ReadableStream<T>({
    async start(controller) {
      try {
        for await (const item of factory()) {
          controller.enqueue(item);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  }) as AsyncIterableStream<T>;
}
