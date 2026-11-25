import { afterEach, describe, expect, it, vi } from "vitest";
import { generateTextWithFallback, streamTextWithFallback } from "@/lib/llm/client";

function geminiJsonResponse(text = "ok"): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: { role: "model", parts: [{ text }] },
          finishReason: "STOP"
        }
      ],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function geminiSseResponse(text = "ok"): Response {
  const chunk = JSON.stringify({
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        finishReason: "STOP"
      }
    ],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 }
  });
  return new Response(`data: ${chunk}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

describe("Google SDK serialized thinkingConfig request bodies", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serializes thinkingBudget for gemini-2.5-flash-lite when explicit effort is set and omits it when unset", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return geminiJsonResponse();
      })
    );

    await generateTextWithFallback({
      chain: [
        {
          provider: "gemini",
          model: "gemini-2.5-flash-lite",
          keySource: "ui",
          apiKey: "AIzaSyTestKey",
          reasoningEffort: "high"
        }
      ],
      prompt: "hi",
      timeoutMsPerEntry: 5_000
    });

    const withEffort = (bodies[0].generationConfig as { thinkingConfig?: Record<string, unknown> } | undefined)?.thinkingConfig;
    expect(withEffort).toEqual({ thinkingBudget: 24576 });
    expect("thinkingLevel" in (withEffort ?? {})).toBe(false);

    await generateTextWithFallback({
      chain: [
        {
          provider: "gemini",
          model: "gemini-2.5-flash-lite",
          keySource: "ui",
          apiKey: "AIzaSyTestKey"
        }
      ],
      prompt: "hi",
      timeoutMsPerEntry: 5_000
    });

    const withoutEffort = (bodies[1].generationConfig as { thinkingConfig?: Record<string, unknown> } | undefined)?.thinkingConfig;
    expect(withoutEffort).toBeUndefined();
  });

  it("serializes thinkingLevel without thinkingBudget for gemini-4 across generate, stream, and Alexa thinking:false", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return String(url).includes("streamGenerateContent") ? geminiSseResponse() : geminiJsonResponse();
      })
    );

    // 1. generateTextWithFallback
    await generateTextWithFallback({
      chain: [
        {
          provider: "gemini",
          model: "gemini-4-hydrogen",
          keySource: "ui",
          apiKey: "AIzaSyTestKey",
          reasoningEffort: "high"
        }
      ],
      prompt: "hi",
      timeoutMsPerEntry: 5_000
    });
    const genThinking = (bodies[0].generationConfig as { thinkingConfig?: Record<string, unknown> } | undefined)?.thinkingConfig;
    expect(genThinking).toEqual({ thinkingLevel: "high" });
    expect("thinkingBudget" in (genThinking ?? {})).toBe(false);

    // 2. streamTextWithFallback (normal chat)
    const streamRes = await streamTextWithFallback({
      chain: [
        {
          provider: "gemini",
          model: "gemini-4-hydrogen",
          keySource: "ui",
          apiKey: "AIzaSyTestKey",
          reasoningEffort: "medium"
        }
      ],
      messages: [{ role: "user", content: "hi" }],
      firstTokenTimeoutMs: 5_000
    });
    for await (const _ of streamRes.fullStream) {
      // drain
    }
    const streamThinking = (bodies[1].generationConfig as { thinkingConfig?: Record<string, unknown> } | undefined)?.thinkingConfig;
    expect(streamThinking).toEqual({ includeThoughts: true, thinkingLevel: "medium" });
    expect("thinkingBudget" in (streamThinking ?? {})).toBe(false);

    // 3. streamTextWithFallback with thinking: false (Alexa voice route):
    // local no-thinking override must NOT drop Gemini 4's thinkingLevel.
    const alexaRes = await streamTextWithFallback({
      chain: [
        {
          provider: "gemini",
          model: "gemini-4-hydrogen",
          keySource: "ui",
          apiKey: "AIzaSyTestKey",
          reasoningEffort: "low"
        }
      ],
      messages: [{ role: "user", content: "hi" }],
      thinking: false,
      firstTokenTimeoutMs: 5_000
    });
    for await (const _ of alexaRes.fullStream) {
      // drain
    }
    const alexaThinking = (bodies[2].generationConfig as { thinkingConfig?: Record<string, unknown> } | undefined)?.thinkingConfig;
    expect(alexaThinking).toEqual({ thinkingLevel: "low" });
    expect("thinkingBudget" in (alexaThinking ?? {})).toBe(false);
  });
});
