import { describe, expect, it, vi, beforeEach } from "vitest";

const aiState = vi.hoisted(() => ({
  generateImpl: null as null | ((args: Record<string, unknown>) => Promise<unknown>),
  streamImpl: null as null | ((args: Record<string, unknown>) => unknown),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: (args: Record<string, unknown>) => {
      if (aiState.generateImpl) return aiState.generateImpl(args);
      throw new Error("generateText mock not set");
    },
    streamText: (args: Record<string, unknown>) => {
      if (aiState.streamImpl) return aiState.streamImpl(args);
      throw new Error("streamText mock not set");
    },
  };
});

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: () => () => ({ provider: "mock", modelId: "mock" }),
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => ({ provider: "mock", modelId: "mock" }),
}));

import {
  isFallbackable,
  isContextExceededError,
  isToolsUnsupportedError,
  getFirstTokenTimeoutMs,
  generateTextWithFallback,
  streamTextWithFallback,
  probeToolCapability,
} from "@/lib/llm/client";

beforeEach(() => {
  aiState.generateImpl = null;
  aiState.streamImpl = null;
  vi.unstubAllEnvs();
});

describe("isFallbackable step-1", () => {
  it("falls back on 404 model not found", () => {
    expect(isFallbackable({ status: 404 })).toBe(true);
    expect(isFallbackable(new Error("model not found"))).toBe(true);
    expect(isFallbackable(new Error("404 Not Found"))).toBe(true);
  });

  it("falls back on context-exceeded", () => {
    expect(isFallbackable(new Error("maximum context length exceeded"))).toBe(true);
    expect(isFallbackable(new Error("input too long, token limit 8192"))).toBe(true);
    expect(isContextExceededError("maximum context length exceeded")).toBe(true);
  });

  it("falls back on tools-unsupported", () => {
    expect(isFallbackable(new Error("does not support tools"))).toBe(true);
    expect(isFallbackable(new Error("tool_choice is not supported by this model"))).toBe(true);
    expect(isToolsUnsupportedError("tool_choice is not supported")).toBe(true);
  });

  it("401 moves to next entry only when provider differs", () => {
    const a = { provider: "openrouter", model: "m1", keySource: "ui" } as never;
    const bSame = { provider: "openrouter", model: "m2", keySource: "ui" } as never;
    const bDiff = { provider: "ollama", model: "m2", keySource: "none" } as never;
    expect(isFallbackable({ status: 401 }, a, bSame)).toBe(false);
    expect(isFallbackable({ status: 401 }, a, bDiff)).toBe(true);
    expect(isFallbackable({ status: 401 })).toBe(false);
  });

  it("still falls back on 429 and 5xx", () => {
    expect(isFallbackable({ status: 429 })).toBe(true);
    expect(isFallbackable({ status: 503 })).toBe(true);
  });
});

describe("generateTextWithFallback chain errors", () => {
  it("annotates errors with chain position and model", async () => {
    aiState.generateImpl = async () => {
      throw Object.assign(new Error("model not found"), { status: 404 });
    };
    const chain = [
      { provider: "ollama", model: "missing-a", keySource: "none" },
      { provider: "ollama", model: "missing-b", keySource: "none" },
    ] as never[];
    const failure = await generateTextWithFallback({ chain, prompt: "hi", timeoutMsPerEntry: 1000 }).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors as Error[];
    expect(errors).toHaveLength(2);
    expect(errors[0].message).toMatch(/\[chain 1\/2 ollama:missing-a\]/);
    expect(errors[1].message).toMatch(/\[chain 2\/2 ollama:missing-b\]/);
    expect(String((failure as Error).message)).toMatch(/1\/2 ollama:missing-a/);
  });

  it("falls back from 404 to the next entry", async () => {
    let calls = 0;
    aiState.generateImpl = async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("404 model not found"), { status: 404 });
      return { text: "ok", provider: "ollama", model: "good", fallbackIndex: 1 };
    };
    const chain = [
      { provider: "ollama", model: "bad", keySource: "none" },
      { provider: "ollama", model: "good", keySource: "none" },
    ] as never[];
    const result = await generateTextWithFallback({ chain, prompt: "hi", timeoutMsPerEntry: 2000 });
    expect(calls).toBe(2);
    expect(result).toMatchObject({ provider: "ollama", model: "good", fallbackIndex: 1 });
  });
});

describe("step retry and stream plumbing", () => {
  it("retries each step once with backoff via SDK maxRetries", async () => {
    const seen: Array<Record<string, unknown>> = [];
    aiState.generateImpl = async (args) => {
      seen.push(args);
      return { text: "ok", steps: [], provider: "x", model: "y", fallbackIndex: 0 };
    };
    const chain = [{ provider: "ollama", model: "m", keySource: "none" }] as never[];
    await generateTextWithFallback({ chain, prompt: "hi", timeoutMsPerEntry: 2000 });
    expect(seen[0]).toMatchObject({ maxRetries: 1 });
  });

  it("passes maxRetries 1 to streamText so 429/5xx on step 2+ retries once", async () => {
    const seen: Array<Record<string, unknown>> = [];
    aiState.streamImpl = (args) => {
      seen.push(args as Record<string, unknown>);
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", text: "hi" };
        })(),
      };
    };
    const chain = [{ provider: "ollama", model: "m", keySource: "none" }] as never[];
    await streamTextWithFallback({ chain, messages: [{ role: "user", content: "hi" }], firstTokenTimeoutMs: 2000 });
    expect(seen[0]).toMatchObject({ maxRetries: 1 });
  });

  it("preserves the original textStream (no dead override)", async () => {
    const textStream = (async function* () {
      yield "hello";
    })();
    aiState.streamImpl = () => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "hello" };
      })(),
      textStream,
    });
    const chain = [{ provider: "ollama", model: "m", keySource: "none" }] as never[];
    const result = await streamTextWithFallback({ chain, messages: [{ role: "user", content: "hi" }], firstTokenTimeoutMs: 2000 });
    expect((result as { textStream: unknown }).textStream).toBe(textStream);
  });

  it("honours user Stop without trying entries", async () => {
    let calls = 0;
    aiState.generateImpl = async () => {
      calls += 1;
      return { text: "ok" };
    };
    const controller = new AbortController();
    controller.abort();
    const chain = [{ provider: "ollama", model: "m", keySource: "none" }] as never[];
    await expect(generateTextWithFallback({ chain, prompt: "hi", abortSignal: controller.signal })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});

describe("first-token timeout config", () => {
  it("defaults generous for slow local models and honours env", () => {
    expect(getFirstTokenTimeoutMs()).toBeGreaterThanOrEqual(60_000);
    vi.stubEnv("PCBUILDSAGE_FIRST_TOKEN_TIMEOUT_MS", "5000");
    expect(getFirstTokenTimeoutMs()).toBe(5000);
  });

  it("hanging first entry falls back to the next endpoint", async () => {
    const hangingStream = {
      fullStream: (async function* () {
        await new Promise(() => {});
        yield { type: "text-delta", text: "never" };
      })(),
    };
    const goodStream = {
      fullStream: (async function* () {
        yield { type: "text-delta", text: "hi" };
      })(),
    };
    let calls = 0;
    aiState.streamImpl = () => {
      calls += 1;
      return calls === 1 ? hangingStream : goodStream;
    };
    const chain = [
      { provider: "ollama", model: "hung", keySource: "none" },
      { provider: "ollama", model: "good", keySource: "none" },
    ] as never[];
    const result = await streamTextWithFallback({
      chain,
      messages: [{ role: "user", content: "hi" }],
      firstTokenTimeoutMs: 50,
    });
    expect(calls).toBe(2);
    expect(result).toMatchObject({ provider: "ollama", model: "good", fallbackIndex: 1 });
  });
});

describe("probeToolCapability proves tool calling", () => {
  it("fails when the model replies without calling ping", async () => {
    aiState.generateImpl = async () => ({ steps: [{ toolCalls: [] }] });
    const result = await probeToolCapability({ provider: "ollama", model: "no-tools", keySource: "none" } as never);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/without calling the ping tool/);
  });

  it("passes when ping is actually invoked", async () => {
    aiState.generateImpl = async () => ({ steps: [{ toolCalls: [{ toolName: "ping" }] }] });
    const result = await probeToolCapability({ provider: "ollama", model: "good", keySource: "none" } as never);
    expect(result.ok).toBe(true);
  });
});
