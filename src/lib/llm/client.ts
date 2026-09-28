import { generateText, streamText, tool, hasToolCall, type AsyncIterableStream, type LanguageModel, type ModelMessage, type StopCondition, type StreamTextResult, type TextStreamPart, type ToolSet, type OnFinishEvent, type OnStepFinishEvent } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import type { LLMChainEntry, LLMProvider, LLMRole } from "@/types";
import { isHostedDemo } from "../config/deployment";
import { envKeyAllowed } from "./env-key-scope";
import { ACCESS_BLOCKED_COPY, FREE_LIMIT_COPY, KEY_REJECTED_COPY } from "@/content/api-key-help";

/** Generous first-token timeout for the main chat stream (local models load slowly). */
export const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 120_000;
/**
 * Per-entry timeout for generateTextWithFallback. It bounds a whole call,
 * including multi-step subagent tool loops (searches + crawls) and history
 * compaction on slow local models, so it is deliberately generous.
 */
export const DEFAULT_ENTRY_TIMEOUT_MS = 180_000;

export function getFirstTokenTimeoutMs(): number {
  const raw = process.env.PCBUILDSAGE_FIRST_TOKEN_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_FIRST_TOKEN_TIMEOUT_MS;
}

export function getEntryTimeoutMs(): number {
  const raw = process.env.PCBUILDSAGE_ENTRY_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_ENTRY_TIMEOUT_MS;
}

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
    const apiKey = resolveApiKey(entry, "GEMINI_API_KEY");
    return createGoogleGenerativeAI({
      apiKey: apiKey ?? (isHostedDemo() ? "" : undefined)
    })(entry.model);
  }

  const baseURL = normalizeBaseUrl(entry.baseUrl ?? defaultBaseUrl(entry.provider), entry.provider === "ollama" ? "ollama" : "openai-compatible");
  const apiKey = resolveApiKey(entry, keyEnv(entry.provider)) || (entry.keySource === "none" ? "pcbuildsage-keyless" : undefined);
  // Ollama is reached through its OpenAI-compatible /v1 endpoint; there is no first-party @ai-sdk/ollama dependency here.
  return createOpenAICompatible({
    name: entry.provider,
    baseURL: entry.provider === "ollama" ? appendV1(baseURL) : baseURL,
    apiKey,
    includeUsage: true,
    transformRequestBody: (args) => sanitizeOpenAICompatibleRequestBody(args, entry.provider, baseURL)
  })(entry.model) as unknown as LanguageModel;
}

export function sanitizeOpenAICompatibleRequestBody(
  args: Record<string, unknown>,
  provider: LLMProvider,
  baseURL?: string
): Record<string, unknown> {
  const body = { ...args };
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((message: unknown) => {
      if (message && typeof message === "object") {
        const msgObj = message as Record<string, unknown>;
        if ("reasoning_content" in msgObj || "reasoning" in msgObj) {
          const cleaned = { ...msgObj };
          delete cleaned.reasoning_content;
          delete cleaned.reasoning;
          return cleaned;
        }
      }
      return message;
    });
  }
  // Local servers (llama.cpp, Ollama) default to one tool call per turn and fail to
  // parse a turn where the model emits several; hosted APIs already allow parallel calls.
  const isLocalServer = provider === "openai-compatible" || provider === "ollama";
  if (isLocalServer && Array.isArray(body.tools) && body.tools.length > 0 && body.parallel_tool_calls === undefined) {
    body.parallel_tool_calls = true;
  }
  const isGroq = provider === "groq" || (typeof baseURL === "string" && baseURL.includes("groq.com"));
  if (isGroq && "reasoning_effort" in body) {
    delete body.reasoning_effort;
  }
  return body;
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
  abortSignal?: AbortSignal;
  /** Per-entry timeout in ms (each fallback entry gets its own budget). */
  timeoutMsPerEntry?: number;
}) {
  const errors: unknown[] = [];
  const entryTimeout = args.timeoutMsPerEntry ?? getEntryTimeoutMs();
  for (const [index, entry] of args.chain.entries()) {
    if (args.abortSignal?.aborted) {
      const abortErr = new Error("Aborted by user.");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    const { signal, cancel } = combineWithTimeout(args.abortSignal, entryTimeout);
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
        abortSignal: signal,
        ...(entry.reasoningEffort ? { reasoning: entry.reasoningEffort } : {}),
        // Retry each step once with SDK exponential backoff (2s initial,
        // honours Retry-After). 429/5xx on step 2+ resume without failing
        // the turn; step-1 failures still fall through to the next entry.
        maxRetries: 1
      });
      cancel();
      return Object.assign(result, { provider: entry.provider, model: entry.model, fallbackIndex: index }) as ServedText<typeof result>;
    } catch (error) {
      cancel();
      if (args.abortSignal?.aborted || (error instanceof Error && error.name === "AbortError" && args.abortSignal?.aborted)) throw error;
      const next = args.chain[index + 1];
      if (!isFallbackable(error, entry, next)) throw error;
      errors.push(annotateChainError(error, entry, index, args.chain.length));
    }
  }
  throw new AggregateError(errors, `All fallback LLM providers failed (${describeChain(args.chain)}).`);
}

export async function streamTextWithFallback(args: {
  chain: LLMChainEntry[];
  system?: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  maxSteps?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stopWhen?: StopCondition<any> | Array<StopCondition<any>>;
  abortSignal?: AbortSignal;
  /** Generous first-token budget per entry; local models load slowly. */
  firstTokenTimeoutMs?: number;
  onStepFinish?: (event: OnStepFinishEvent<ToolSet>) => void | Promise<void>;
  onFinish?: (event: OnFinishEvent<ToolSet>) => void | Promise<void>;
  prepareStep?: Parameters<typeof streamText>[0]["prepareStep"];
}) {
  if (!args.chain.length) throw new Error("LLM chain is empty.");
  const errors: unknown[] = [];
  const firstTokenTimeout = args.firstTokenTimeoutMs ?? getFirstTokenTimeoutMs();
  for (const [index, entry] of args.chain.entries()) {
    if (args.abortSignal?.aborted) {
      const abortErr = new Error("Aborted by user.");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    // Each fallback entry gets its own first-token budget. The SDK sees the
    // user Stop signal for the whole stream (not just until the first token)
    // combined with this entry's first-token timeout.
    const entryController = new AbortController();
    const timer = setTimeout(() => entryController.abort(new Error(`First token timeout after ${firstTokenTimeout}ms`)), firstTokenTimeout);
    const abortSignal = args.abortSignal ? AbortSignal.any([args.abortSignal, entryController.signal]) : entryController.signal;
    try {
      const result = streamText({
        ...args,
        model: createLanguageModel(entry),
        ...(entry.reasoningEffort ? { reasoning: entry.reasoningEffort } : {}),
        // Per-step retry with SDK exponential backoff: 429/5xx on step 2+
        // retries that step once instead of failing the turn.
        maxRetries: 1,
        abortSignal
      });
      const started = await probeStarted(result, firstTokenTimeout);
      clearTimeout(timer);
      return withServedStreams(result, started.fullStream, entry, index, errors);
    } catch (error) {
      clearTimeout(timer);
      if (args.abortSignal?.aborted) throw error;
      const next = args.chain[index + 1];
      if (!isFallbackable(error, entry, next)) throw error;
      errors.push(annotateChainError(error, entry, index, args.chain.length));
    }
  }
  throw new AggregateError(errors, `All fallback LLM providers failed before streaming content (${describeChain(args.chain)}).`);
}

/** Probe budget: slow reasoning models can take tens of seconds to call ping. */
export const PROBE_TIMEOUT_MS = 45_000;
/** Longest Retry-After the probe waits out before its single retry. */
export const PROBE_MAX_RETRY_WAIT_MS = 10_000;
const PROBE_DEFAULT_RETRY_WAIT_MS = 2_000;

/**
 * Why a tool probe failed, so the UI can explain it:
 * - "no_tool_call": the model answered, but in text, without calling the tool.
 * - "request_failed": the request itself failed (network, auth, rate limit, timeout).
 */
export type ToolProbeFailure = "no_tool_call" | "request_failed";

export type ToolProbeResult = { ok: boolean; reason?: ToolProbeFailure; remedies?: string[]; error?: string };

/**
 * Onboarding gate: proves the entry can make a real tool call by asking it to
 * call a `ping` tool. One retry on 429/5xx (waiting out Retry-After up to
 * PROBE_MAX_RETRY_WAIT_MS) so a single free-tier rate limit does not fail setup.
 */
export async function probeToolCapability(
  entry: LLMChainEntry,
  options?: { timeoutMs?: number; abortSignal?: AbortSignal; sleep?: (ms: number) => Promise<void> }
): Promise<ToolProbeResult> {
  const { signal, cancel } = combineWithTimeout(options?.abortSignal, options?.timeoutMs ?? PROBE_TIMEOUT_MS);
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await generateText({
          model: createLanguageModel(entry),
          prompt: "Call the ping tool once.",
          tools: {
            ping: tool({
              description: "Small setup probe. Use when asked to call it.",
              inputSchema: z.object({ value: z.string().describe("Any short value to echo.") }),
              execute: async ({ value }) => ({ value })
            })
          },
          // Stop as soon as ping fires. A text-only reply has no tool calls,
          // so the SDK loop ends after that one step on its own.
          stopWhen: [hasToolCall("ping")],
          // Retries are handled below so Retry-After can be capped.
          maxRetries: 0,
          abortSignal: signal
        });
        // The generate call succeeding is not enough: require proof the model
        // actually invoked ping (some endpoints return text instead of a tool
        // call when tool_choice is ignored, e.g. unconfigured local servers).
        const steps = await result.steps;
        const calledPing = steps.some((step) =>
          (step.toolCalls ?? []).some((call) => (call as { toolName?: unknown }).toolName === "ping")
        );
        if (!calledPing) {
          return {
            ok: false,
            reason: "no_tool_call",
            error: "The model replied in plain text instead of calling the test tool, so it can't use PCBuildSage's tools.",
            remedies: ["Enable tool calling on the backend launch flags or model template.", "Switch to a model that supports native tool calling."]
          };
        }
        return { ok: true };
      } catch (error) {
        const wait = attempt === 0 && !signal?.aborted ? probeRetryDelayMs(error) : undefined;
        if (wait === undefined) throw error;
        await sleep(wait);
      }
    }
  } catch (error) {
    return { ok: false, reason: "request_failed", ...describeProbeRequestFailure(error, signal) };
  } finally {
    cancel();
  }
}

/** Delay before the probe's single retry, or undefined when it should not retry. */
function probeRetryDelayMs(error: unknown): number | undefined {
  const status = statusFromError(error);
  if (status !== 429 && !(status !== undefined && status >= 500)) return undefined;
  const retryAfterMs = retryAfterFromError(error);
  if (retryAfterMs === undefined) return PROBE_DEFAULT_RETRY_WAIT_MS;
  return retryAfterMs <= PROBE_MAX_RETRY_WAIT_MS ? retryAfterMs : undefined;
}

function retryAfterFromError(error: unknown): number | undefined {
  const headers = (error as { responseHeaders?: Record<string, string> } | undefined)?.responseHeaders
    ?? (error as { cause?: { responseHeaders?: Record<string, string> } } | undefined)?.cause?.responseHeaders;
  if (!headers) return undefined;
  const ms = Number.parseFloat(headers["retry-after-ms"] ?? "");
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const raw = headers["retry-after"];
  if (!raw) return undefined;
  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw) - Date.now();
  return Number.isFinite(date) ? Math.max(0, date) : undefined;
}

function describeProbeRequestFailure(error: unknown, signal: AbortSignal | undefined): { error: string; remedies: string[] } {
  const detail = error instanceof Error ? error.message : String(error);
  const status = statusFromError(error);
  if (signal?.aborted || /timeout|timed out|aborted/i.test(detail)) {
    return { error: `The tool test didn't finish in time (${detail}).`, remedies: ["Try again; slow or reasoning models can take a while to answer.", "Pick a faster model."] };
  }
  if (status === 429 || /rate limit|too many requests|quota/i.test(detail)) {
    return { error: `${FREE_LIMIT_COPY} (${detail})`, remedies: ["Wait a bit and test again, or pick another free model."] };
  }
  if (status === 401) {
    return { error: `${KEY_REJECTED_COPY} (${detail})`, remedies: ["Check you copied the full key into Settings, then test again."] };
  }
  if (status === 403) {
    return { error: `${ACCESS_BLOCKED_COPY} (${detail})`, remedies: ["Pick another model or provider, then test again."] };
  }
  return { error: `The tool test request failed (${detail}).`, remedies: ["Check the endpoint and try again."] };
}

export function isFallbackable(error: unknown, currentEntry?: LLMChainEntry, nextEntry?: LLMChainEntry): boolean {
  const status = statusFromError(error);
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  // 401/403: credentials for this provider are wrong. Stay on the same
  // provider would just repeat the failure, but a different next provider
  // gets its own chance (e.g. bad OpenRouter key -> local Ollama).
  if (status === 401 || status === 403 || message.includes("unauthorized") || message.includes("forbidden")) {
    if (currentEntry && nextEntry && nextEntry.provider !== currentEntry.provider) return true;
    return false;
  }
  // 404: model not found on this endpoint -> try next entry.
  if (status === 404 || message.includes("404") || message.includes("not found") || message.includes("no such model") || message.includes("model not found")) return true;
  if (isContextExceededError(message, status)) return true;
  if (isToolsUnsupportedError(message, status)) return true;
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  return [
    "abort",
    "aborted",
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
    const maybe = error as {
      statusCode?: unknown;
      status?: unknown;
      response?: { status?: unknown };
      lastError?: unknown;
      cause?: unknown;
    };
    const direct = maybe.statusCode ?? maybe.status ?? maybe.response?.status;
    if (typeof direct === "number") return direct;
    // AI SDK wraps provider failures (RetryError/APICallError chains).
    for (const nested of [maybe.lastError, maybe.cause]) {
      if (typeof nested === "object" && nested) {
        const inner = nested as { statusCode?: unknown; status?: unknown; response?: { status?: unknown } };
        const s = inner.statusCode ?? inner.status ?? inner.response?.status;
        if (typeof s === "number") return s;
      }
    }
    const msg = error instanceof Error ? error.message : String(error ?? "");
    const match = msg.match(/\[HTTP\s+(\d{3})\]/i) ?? msg.match(/\bHTTP\s+(\d{3})\b/i);
    if (match?.[1]) return Number.parseInt(match[1], 10);
  }
  return undefined;
}

export function isContextExceededError(messageLower: string, status?: number): boolean {
  const msg = messageLower.toLowerCase();
  void status;
  return [
    "context length",
    "context_length",
    "maximum context",
    "input too long",
    "too many tokens",
    "token limit",
    "max_tokens",
    "context window",
    "context exceeded",
    "prompt too long",
    "input exceeds"
  ].some((needle) => msg.includes(needle));
}

export function isToolsUnsupportedError(messageLower: string, status?: number): boolean {
  const msg = messageLower.toLowerCase();
  void status;
  return [
    "function calling",
    "function_call",
    "tool_choice",
    "tool-call",
    "tool call",
    "does not support tools",
    "tools not supported",
    "unsupported tool",
    "no tool support",
    "tool use",
    "tool_use"
  ].some((needle) => msg.includes(needle));
}

function describeChain(chain: LLMChainEntry[]): string {
  return chain.map((entry, index) => `${index + 1}/${chain.length} ${entry.provider}:${entry.model}`).join(", ");
}

function annotateChainError(error: unknown, entry: LLMChainEntry, index: number, total: number): unknown {
  const prefix = `[chain ${index + 1}/${total} ${entry.provider}:${entry.model}]`;
  if (error instanceof Error) {
    const annotated = new Error(`${prefix} ${error.message}`);
    annotated.name = error.name;
    (annotated as { cause?: unknown }).cause = error;
    return annotated;
  }
  return new Error(`${prefix} ${String(error)}`);
}

function combineWithTimeout(userSignal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal | undefined; cancel: () => void } {
  if (userSignal?.aborted) return { signal: userSignal, cancel: () => {} };
  const controller = new AbortController();
  const onAbort = () => controller.abort(userSignal?.reason ?? new Error("Aborted by user."));
  userSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`LLM entry timeout after ${timeoutMs}ms`)), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      userSignal?.removeEventListener("abort", onAbort);
    }
  };
}

export function resolveApiKey(entry: LLMChainEntry, envKey: string): string | undefined {
  if (entry.keySource === "none") return undefined;
  if (isHostedDemo()) return entry.apiKey;
  return entry.apiKey ?? (envKeyAllowed(entry) ? process.env[envKey] : undefined);
}

export function keyEnv(provider: LLMProvider): string {
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  if (provider === "gemini") return "GEMINI_API_KEY";
  if (provider === "groq") return "GROQ_API_KEY";
  if (provider === "ollama") return "OLLAMA_API_KEY";
  return "OPENAI_COMPATIBLE_API_KEY";
}

function defaultBaseUrl(provider: LLMProvider): string {
  if (provider === "ollama") return process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  if (provider === "openrouter") return "https://openrouter.ai/api/v1";
  if (provider === "groq") return "https://api.groq.com/openai/v1";
  return process.env.OPENAI_COMPATIBLE_BASE_URL ?? "http://localhost:8000/v1";
}

/**
 * Stream parts that do NOT prove the provider is responding: the SDK emits
 * `start`/`start-step` itself, and `raw` is opt-in transport noise. Anything
 * else (text/reasoning/tool-input starts and deltas, tool calls, sources,
 * files, step finish) means the model is producing output.
 */
const NON_OUTPUT_PART_TYPES = new Set<string>(["start", "start-step", "raw"]);

/**
 * Waits for the first part that proves the entry is producing output (or a
 * timeout / error, which rejects so the caller can fall back), then returns a
 * fullStream that replays the buffered parts and continues the original.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function probeStarted(result: StreamTextResult<ToolSet, any, any>, firstTokenTimeoutMs: number): Promise<{ fullStream: AsyncIterableStream<TextStreamPart<ToolSet>> }> {
  const source = openPartSource(result.fullStream);
  const buffer: TextStreamPart<ToolSet>[] = [];
  let timer: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void source.cancel().catch(() => {});
      const err = new Error(`First token timeout after ${firstTokenTimeoutMs}ms`);
      err.name = "TimeoutError";
      reject(err);
    }, firstTokenTimeoutMs);
  });

  try {
    while (true) {
      const next = await Promise.race([source.next(), timeoutPromise]);
      if (next.done) {
        break;
      }
      const part = next.value;
      buffer.push(part);

      if (part.type === "error") {
        throw part.error;
      }

      // The AI SDK surfaces an entry-timeout or transport abort as an
      // `abort` stream part and then ends the stream normally (it does not
      // reject). Without this, a hung endpoint resolves as an empty result
      // from entry 0 and never falls through to the next endpoint.
      // User Stop still rethrows via the args.abortSignal check in the
      // streamTextWithFallback catch below.
      if (part.type === "abort") {
        const reason = (part as { reason?: unknown }).reason;
        throw reason instanceof Error
          ? reason
          : new Error(
              typeof reason === "string" && reason.length > 0
                ? reason.replace(/^Error:\s*/, "")
                : "Stream aborted before first token"
            );
      }

      if (!NON_OUTPUT_PART_TYPES.has(part.type)) {
        break;
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  return { fullStream: replayThenContinue(buffer, source) };
}

type PartSource<T> = { next(): Promise<IteratorResult<T>>; cancel(): Promise<void> };

/**
 * Reads the SDK fullStream through a ReadableStream reader when available:
 * reader.cancel() takes effect even while a read is pending, whereas an
 * async iterator's return() waits for that read. Plain async iterables
 * (test doubles) fall back to the iterator protocol.
 */
function openPartSource<T>(stream: AsyncIterable<T>): PartSource<T> {
  if (stream instanceof ReadableStream) {
    const reader = (stream as ReadableStream<T>).getReader();
    return {
      next: async () => {
        const { done, value } = await reader.read();
        return done ? { done: true, value: undefined } : { done: false, value: value as T };
      },
      cancel: () => reader.cancel()
    };
  }
  const iterator = stream[Symbol.asyncIterator]();
  return { next: () => iterator.next(), cancel: async () => { await iterator.return?.(); } };
}

/**
 * Pull-based stream: replays the buffered parts, then continues the source.
 * An `error` part becomes a stream error; cancel() releases the SDK stream.
 */
function replayThenContinue(buffer: TextStreamPart<ToolSet>[], source: PartSource<TextStreamPart<ToolSet>>): AsyncIterableStream<TextStreamPart<ToolSet>> {
  const pending = [...buffer];
  return new ReadableStream<TextStreamPart<ToolSet>>({
    async pull(controller) {
      try {
        const part = pending.length ? pending.shift()! : await source.next().then((next) => (next.done ? undefined : next.value));
        if (!part) controller.close();
        else if (part.type === "error") controller.error(part.error);
        else controller.enqueue(part);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await source.cancel();
    }
  }) as AsyncIterableStream<TextStreamPart<ToolSet>>;
}

function withServedStreams(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: StreamTextResult<ToolSet, any, any>,
  fullStream: AsyncIterableStream<TextStreamPart<ToolSet>>,
  entry: LLMChainEntry,
  fallbackIndex: number,
  errors?: unknown[]
) {
  // Only fullStream needs rebuilding: probeStarted partially consumed it.
  // textStream was never read, so the original stays valid — the previous
  // tee()+pipeThrough rebuild was dead weight (and broke CLI text consumers).
  const served = Object.create(result) as ServedText<typeof result>;
  Object.defineProperties(served, {
    fullStream: { value: fullStream as AsyncIterableStream<TextStreamPart<ToolSet>>, enumerable: true },
    provider: { value: entry.provider, enumerable: true },
    model: { value: entry.model, enumerable: true },
    fallbackIndex: { value: fallbackIndex, enumerable: true },
    errors: { value: errors, enumerable: true }
  });
  return served;
}
