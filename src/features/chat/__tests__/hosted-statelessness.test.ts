import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/lib/llm/messages";
import type { AppConfig } from "@/types";
import * as sessionsModule from "@/lib/sessions";
import { POST as chatCompactPost } from "@/app/api/chat/compact/route";
import { streamChat } from "@/lib/llm/chat-engine";

// Mock client.generateTextWithFallback for compaction
vi.mock("@/lib/llm/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/llm/client")>("@/lib/llm/client");
  return {
    ...actual,
    generateTextWithFallback: vi.fn().mockImplementation(async () => ({
      text: "Progress: Selected GPU RTX 4070. User wants white case.",
      model: "mock-model"
    })),
    streamTextWithFallback: vi.fn().mockImplementation(async () => ({
      toUIMessageStreamResponse: () =>
        new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" }
        }),
      provider: "mock-provider",
      model: "mock-model",
      fallbackIndex: 0,
      errors: []
    }))
  };
});

describe("Track A: Hosted Mode Statelessness & Compaction Boundary", () => {
  const originalEnv = process.env.PCBUILDSAGE_DEPLOYMENT_MODE;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = originalEnv;
    } else {
      delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
    }
  });

  const geminiChain = [{ provider: "gemini" as const, model: "gemini-2.0-flash", keySource: "none" as const }];

  const testConfig: AppConfig = {
    countryCode: "IN",
    currency: "INR",
    dbPath: "/mock/db.sqlite",
    theme: "sage-dark",
    personality: "helpful-consultant",
    tier2Enabled: false,
    freeformConsultEnabled: false,
    search: { provider: "none", crawlEnabled: false },
    llm: {
      roles: {
        chat: geminiChain,
        subagent: geminiChain,
        scraper: geminiChain
      },
      chain: geminiChain
    }
  };

  const requestConfigPayload = {
    llmChain: geminiChain,
    chatLlmChain: geminiChain,
    subagentLlmChain: geminiChain,
    scraperLlmChain: geminiChain,
    searchProvider: "none"
  };

  it("Challenger 1: In hosted mode, getSessionsDb and session persistence are NEVER touched across chat and compaction", async () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";

    const getSessionsDbSpy = vi.spyOn(sessionsModule, "getSessionsDb");
    const getSessionSpy = vi.spyOn(sessionsModule, "getSession");
    const saveSessionSpy = vi.spyOn(sessionsModule, "saveSession");
    const setCompactingSpy = vi.spyOn(sessionsModule, "setSessionCompacting");

    const messages: ChatMessage[] = [
      { id: "u-1", role: "user", content: "Build me a gaming PC", parts: [{ type: "text", text: "Build me a gaming PC" }] },
      { id: "a-1", role: "assistant", content: "Here is option 1.", parts: [{ type: "text", text: "Here is option 1." }] }
    ];

    // 1. Test /api/chat/compact in hosted mode
    const compactReq = new Request("http://localhost:3000/api/chat/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess-hosted-1",
        messages: [
          { id: "u-1", role: "user", content: "Build me a gaming PC", parts: [{ type: "text", text: "Build me a gaming PC" }] },
          { id: "a-1", role: "assistant", content: "X".repeat(25000), parts: [{ type: "text", text: "X".repeat(25000) }] }
        ],
        config: requestConfigPayload,
        force: true
      })
    });

    const compactRes = await chatCompactPost(compactReq);
    expect(compactRes.status).toBe(200);
    const compactJson = await compactRes.json();
    expect(compactJson.compacted).toBe(true);
    expect(compactJson.compactContext).toBeDefined();
    expect(compactJson.compactContext.messages).toBeDefined();

    // 2. Test streamChat in hosted mode with client-supplied compact context
    await streamChat(
      testConfig,
      messages,
      "sess-hosted-1",
      undefined,
      compactJson.compactContext
    );

    // Verify database was NEVER opened or touched
    expect(getSessionsDbSpy).not.toHaveBeenCalled();
    expect(getSessionSpy).not.toHaveBeenCalled();
    expect(saveSessionSpy).not.toHaveBeenCalled();
    expect(setCompactingSpy).not.toHaveBeenCalled();
  });

  it("Challenger 2: Compaction -> simulated restart -> resend sequence succeeds with no server state", async () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";

    // Step 1: Compaction happens via /api/chat/compact
    const compactReq = new Request("http://localhost:3000/api/chat/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess-stateless-overflow",
        messages: [
          { id: "msg-1", role: "user", content: "I want an ITX build", parts: [{ type: "text", text: "I want an ITX build" }] },
          { id: "msg-2", role: "assistant", content: "Large history... ".repeat(1500), parts: [{ type: "text", text: "Large history... ".repeat(1500) }] }
        ],
        config: requestConfigPayload,
        force: true
      })
    });

    const compactRes = await chatCompactPost(compactReq);
    expect(compactRes.status).toBe(200);
    const compactData = await compactRes.json();
    expect(compactData.compacted).toBe(true);

    const clientStoredContext = compactData.compactContext;
    expect(clientStoredContext).toBeDefined();
    expect(clientStoredContext.messages.length).toBeGreaterThan(0);

    // Step 2: Simulate server restart:
    // All in-memory module state is reset, no server database exists.
    vi.restoreAllMocks();
    const getSessionsDbSpy = vi.spyOn(sessionsModule, "getSessionsDb");

    // Step 3: Resend with client-stored context in the request payload
    const resumedMessages: ChatMessage[] = [
      { id: "msg-1", role: "user", content: "I want an ITX build", parts: [{ type: "text", text: "I want an ITX build" }] },
      { id: "msg-2", role: "assistant", content: "Summary...", parts: [{ type: "text", text: "Summary..." }] },
      { id: "msg-3", role: "user", content: "make it a white case", parts: [{ type: "text", text: "make it a white case" }] }
    ];

    const streamResult = await streamChat(
      testConfig,
      resumedMessages,
      "sess-stateless-overflow",
      undefined,
      clientStoredContext
    );

    expect(streamResult).toBeDefined();
    // Database was never touched during recovery or resend
    expect(getSessionsDbSpy).not.toHaveBeenCalled();
  });

  it("Challenger 3: Local mode behaves as before (uses server sessions database)", async () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "local";

    const saveSessionSpy = vi.spyOn(sessionsModule, "saveSession");
    const getSessionSpy = vi.spyOn(sessionsModule, "getSession").mockReturnValue({
      id: "sess-local-1",
      revision: 1,
      title: "Local chat",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      country_code: "IN",
      currency: "INR",
      messages: [],
      build_state: null,
      compact_context: null
    });

    const compactReq = new Request("http://localhost:3000/api/chat/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess-local-1",
        messages: [
          { id: "u-1", role: "user", content: "Build me a gaming PC", parts: [{ type: "text", text: "Build me a gaming PC" }] },
          { id: "a-1", role: "assistant", content: "X".repeat(25000), parts: [{ type: "text", text: "X".repeat(25000) }] }
        ],
        config: requestConfigPayload,
        force: true
      })
    });

    const res = await chatCompactPost(compactReq);
    expect(res.status).toBe(200);

    // In local mode, saveSession is called to persist to SQLite
    expect(getSessionSpy).toHaveBeenCalledWith("sess-local-1");
    expect(saveSessionSpy).toHaveBeenCalled();
    const saved = saveSessionSpy.mock.calls[0][0];
    expect(saved.id).toBe("sess-local-1");
    expect(saved.compactContext).toBeDefined();
  });

  it("Challenger 4: Mid-turn compaction re-fire confirmation and fix verification", async () => {
    // When boundary was set at the user message starting the turn:
    // On the subsequent turn, capped.slice(boundaryIndex + 1) re-appended
    // all tool calls from the turn that was just compacted.
    //
    // With the fix, boundary is set to the assistant response message ID,
    // so already-summarised tool calls are NOT re-appended on the next turn.

    const turn1UserMsg: ChatMessage = {
      id: "user-turn-1",
      role: "user",
      content: "Build PC",
      parts: [{ type: "text", text: "Build PC" }]
    };
    const turn1AsstMsg: ChatMessage = {
      id: "asst-turn-1",
      role: "assistant",
      parts: [
        {
          type: "tool-search_products",
          toolCallId: "call-1",
          state: "output-available",
          input: { category: "gpu" },
          output: { results: [] }
        },
        {
          type: "text",
          text: "Here is your build."
        }
      ]
    };
    const turn2UserMsg: ChatMessage = {
      id: "user-turn-2",
      role: "user",
      content: "Make it a white case",
      parts: [{ type: "text", text: "Make it a white case" }]
    };

    // Simulate compact context created with boundary at assistant message ID
    const compactContext: sessionsModule.StoredCompactContext = {
      messages: [
        { role: "user", content: "Build PC" },
        { role: "assistant", content: "[Progress & Handoff Summary]\nSelected parts." }
      ],
      boundaryMessageId: "asst-turn-1",
      snapshot: null
    };

    // Full history on Turn 2 sent by client
    const turn2History: ChatMessage[] = [
      turn1UserMsg,
      turn1AsstMsg,
      turn2UserMsg
    ];

    // Mock streamTextWithFallback to inspect the initialModelMessages received
    const { streamTextWithFallback } = await import("@/lib/llm/client");
    let receivedMessages: unknown[] = [];
    vi.mocked(streamTextWithFallback).mockImplementationOnce(async (opts: { messages: unknown[] }) => {
      receivedMessages = opts.messages;
      return {
        toUIMessageStreamResponse: () => new Response("ok"),
        provider: "gemini",
        model: "gemini-2.0-flash",
        fallbackIndex: 0
      } as unknown as ReturnType<typeof streamTextWithFallback>;
    });

    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    await streamChat(testConfig, turn2History, "sess-test", undefined, compactContext);

    // Verify: receivedMessages must start with the compact context and only append turn 2 user message.
    // It must NOT contain the re-appended tool calls from Turn 1!
    expect(receivedMessages).toHaveLength(3);
    expect((receivedMessages[0] as { role: string }).role).toBe("user");
    expect((receivedMessages[1] as { role: string }).role).toBe("assistant");
    expect((receivedMessages[2] as { role: string }).role).toBe("user");

    const user2Msg = receivedMessages[2] as { content: unknown };
    const user2Text = typeof user2Msg.content === "string"
      ? user2Msg.content
      : Array.isArray(user2Msg.content)
        ? (user2Msg.content[0] as { text?: string })?.text
        : "";
    expect(user2Text).toBe("Make it a white case");

    // Proves tool calls from Turn 1 are not replayed
    const hasReplayedToolCalls = receivedMessages.some(
      (m: unknown) => (m as { role: string }).role === "tool" || (Array.isArray((m as { parts?: unknown[] }).parts) && (m as { parts: { type?: string }[] }).parts.some((p) => p.type?.startsWith("tool")))
    );
    expect(hasReplayedToolCalls).toBe(false);
  });
});
