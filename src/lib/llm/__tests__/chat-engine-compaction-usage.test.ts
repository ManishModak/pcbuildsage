import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { streamChat } from "../chat-engine";
import * as clientModule from "../client";
import * as compactionModule from "../compaction";
import type { AppConfig } from "@/types";

vi.mock("../client", () => ({
  streamTextWithFallback: vi.fn(),
  generateTextWithFallback: vi.fn()
}));

vi.mock("../compaction", () => ({
  compactConversation: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  appendChatLog: vi.fn().mockResolvedValue(undefined)
}));

describe("chat-engine prepareStep token compaction with provider usage", () => {
  const contextLimit = 65_536;
  const config: AppConfig = {
    dbPath: ":memory:",
    countryCode: "US",
    currency: "USD",
    personality: "balanced",
    theme: "sage-dark",
    tier2Enabled: false,
    freeformConsultEnabled: false,
    llm: {
      chain: [],
      roles: {
        chat: [{ provider: "gemini", model: "gemini-2.0-flash", keySource: "none", contextLimit }],
        subagent: [],
        scraper: []
      }
    },
    search: { provider: "none", crawlEnabled: false }
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fires compaction at real 78% from mocked model usage, even when characters ÷ 3.5 is only 60%", async () => {
    let capturedPrepareStep:
      | ((options: { steps: unknown[]; messages: ModelMessage[] }) => Promise<{ messages?: ModelMessage[] }>)
      | undefined;

    vi.mocked(clientModule.streamTextWithFallback).mockImplementation((options: unknown) => {
      const opts = options as {
        prepareStep?: (options: { steps: unknown[]; messages: ModelMessage[] }) => Promise<{ messages?: ModelMessage[] }>;
      };
      capturedPrepareStep = opts.prepareStep;
      return {} as never;
    });

    const compactedMessages: ModelMessage[] = [
      { role: "user", content: "Compacted user prompt" },
      { role: "assistant", content: "[Progress & Handoff Summary] Summary text" }
    ];

    vi.mocked(compactionModule.compactConversation).mockResolvedValue({
      compacted: true,
      messages: compactedMessages,
      handoffText: "Summary text",
      tokensBefore: 52000,
      tokensAfter: 500
    });

    // Sized so that messages + system prompt + tools overhead ≈ 60% of contextLimit
    // 60% of 65,536 = ~39,321 tokens.
    // Subtracting ~6,500 tokens for system prompt + tools overhead leaves ~32,800 tokens for messages.
    const messageTokens = 32_800;
    const content60 = "M".repeat(Math.floor(messageTokens * 3.5));

    await streamChat(config, [{ role: "user", content: "Initial query" }]);

    expect(capturedPrepareStep).toBeDefined();

    // 1. Without step usage data, characters ÷ 3.5 yields ~60% and compaction does NOT fire:
    const messages60: ModelMessage[] = [{ role: "user", content: content60 }];
    const resultNoUsage = await capturedPrepareStep!({
      steps: [],
      messages: messages60
    });
    expect(resultNoUsage).toEqual({});
    expect(compactionModule.compactConversation).not.toHaveBeenCalled();

    // 2. With mocked model reporting 78% usage (51,118 tokens):
    const tokens78 = Math.ceil(contextLimit * 0.78);
    const mockedSteps = [
      {
        usage: { inputTokens: tokens78, outputTokens: 20 },
        text: "Step output",
        toolCalls: [],
        toolResults: []
      }
    ];

    const resultWithUsage = await capturedPrepareStep!({
      steps: mockedSteps,
      messages: messages60
    });

    // Compaction FIRES at the real 78%!
    expect(compactionModule.compactConversation).toHaveBeenCalledTimes(1);
    expect(resultWithUsage).toEqual({ messages: compactedMessages });
  });
});
