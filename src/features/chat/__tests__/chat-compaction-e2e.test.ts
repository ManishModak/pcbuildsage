import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/lib/llm/messages";
import type { AppConfig } from "@/types";
import * as sessionsModule from "@/lib/sessions";
import * as compactionModule from "@/lib/llm/compaction";
import * as clientModule from "@/lib/llm/client";
import { streamChat } from "@/lib/llm/chat-engine";
import { GET as sessionsGet, POST as sessionsPost } from "@/app/api/sessions/route";
import { GET as sessionDetailGet } from "@/app/api/sessions/[id]/route";

// Mock client and logger modules
vi.mock("@/lib/llm/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/llm/client")>("@/lib/llm/client");
  return {
    ...actual,
    generateTextWithFallback: vi.fn().mockImplementation(async () => ({
      text: "Progress: Selected GPU RTX 4070. User wants white case.",
      model: "mock-model"
    })),
    streamTextWithFallback: vi.fn()
  };
});

vi.mock("@/lib/logger", () => ({
  appendChatLog: vi.fn().mockResolvedValue(undefined)
}));

describe("Chat Compaction End-to-End Integration Suite", () => {
  const originalEnv = process.env.PCBUILDSAGE_DEPLOYMENT_MODE;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = originalEnv;
    } else {
      delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
    }
  });

  const geminiChain = [{ provider: "gemini" as const, model: "gemini-2.0-flash", keySource: "none" as const, contextLimit: 65536 }];

  const testConfig: AppConfig = {
    countryCode: "IN",
    currency: "INR",
    dbPath: ":memory:",
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

  it("Integration 1: Long local chat crosses 78%, compacts, and continues with next assistant turn in local mode", async () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "local";

    const getSessionSpy = vi.spyOn(sessionsModule, "getSession").mockReturnValue({
      id: "sess-local-e2e",
      revision: 1,
      title: "Local E2E Session",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      country_code: "IN",
      currency: "INR",
      messages: [],
      build_state: null,
      compact_context: null
    });
    const saveSessionSpy = vi.spyOn(sessionsModule, "saveSession");
    const setCompactingSpy = vi.spyOn(sessionsModule, "setSessionCompacting");

    let prepareStepFn: ((opts: { steps: unknown[]; messages: unknown[] }) => Promise<{ messages?: unknown[] }>) | undefined;

    vi.mocked(clientModule.streamTextWithFallback).mockImplementation(async (opts: unknown) => {
      const options = opts as {
        prepareStep?: (opts: { steps: unknown[]; messages: unknown[] }) => Promise<{ messages?: unknown[] }>;
        stopWhen?: unknown;
      };
      prepareStepFn = options.prepareStep;

      return {
        toUIMessageStreamResponse: () =>
          new Response(JSON.stringify({ status: "streaming_ok" }), {
            headers: { "Content-Type": "application/json" }
          }),
        provider: "gemini",
        model: "gemini-2.0-flash",
        fallbackIndex: 0,
        errors: []
      } as unknown as ReturnType<typeof clientModule.streamTextWithFallback>;
    });

    const messages: ChatMessage[] = [
      { id: "u-1", role: "user", content: "Build a gaming PC under 100k", parts: [{ type: "text", text: "Build a gaming PC under 100k" }] },
      { id: "a-1", role: "assistant", content: "Sure, let's explore options.", parts: [{ type: "text", text: "Sure, let's explore options." }] }
    ];

    const streamResult = await streamChat(testConfig, messages, "sess-local-e2e");
    expect(streamResult).toBeDefined();
    expect(prepareStepFn).toBeDefined();

    // Trigger step where token count exceeds 78% (e.g., provider reports 52,000 / 65,536 = 79.3%)
    const longChatHistory = [
      { role: "user" as const, content: "Build a gaming PC under 100k. ".repeat(20) },
      { role: "assistant" as const, content: "Let us explore options with RTX 4060 and Ryzen 5 7600. ".repeat(20) }
    ];

    const stepWithHighUsage = {
      usage: { promptTokens: 52_000, completionTokens: 400, totalTokens: 52_400 },
      toolResults: []
    };

    const prepareStepResult = await prepareStepFn!({
      steps: [stepWithHighUsage],
      messages: longChatHistory
    });

    // Verify compaction fired and returned compacted messages
    expect(prepareStepResult).toBeDefined();
    expect(prepareStepResult.messages).toBeDefined();
    expect(setCompactingSpy).toHaveBeenCalledWith("sess-local-e2e", true);
    expect(setCompactingSpy).toHaveBeenCalledWith("sess-local-e2e", false);
    expect(saveSessionSpy).toHaveBeenCalled();
    const saved = saveSessionSpy.mock.calls[0][0];
    expect(saved.id).toBe("sess-local-e2e");
    expect(saved.compactContext).toBeDefined();

    getSessionSpy.mockRestore();
    saveSessionSpy.mockRestore();
    setCompactingSpy.mockRestore();
  });

  it("Integration 2: Long hosted chat crosses 78%, compacts, and continues with zero server session database access", async () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";

    const getSessionsDbSpy = vi.spyOn(sessionsModule, "getSessionsDb");
    const getSessionSpy = vi.spyOn(sessionsModule, "getSession");
    const saveSessionSpy = vi.spyOn(sessionsModule, "saveSession");
    const setCompactingSpy = vi.spyOn(sessionsModule, "setSessionCompacting");

    let prepareStepFn: ((opts: { steps: unknown[]; messages: unknown[] }) => Promise<{ messages?: unknown[] }>) | undefined;

    vi.mocked(clientModule.streamTextWithFallback).mockImplementation(async (opts: unknown) => {
      const options = opts as {
        prepareStep?: (opts: { steps: unknown[]; messages: unknown[] }) => Promise<{ messages?: unknown[] }>;
      };
      prepareStepFn = options.prepareStep;

      return {
        toUIMessageStreamResponse: () =>
          new Response(JSON.stringify({ status: "hosted_stream_ok" }), {
            headers: { "Content-Type": "application/json" }
          }),
        provider: "gemini",
        model: "gemini-2.0-flash",
        fallbackIndex: 0,
        errors: []
      } as unknown as ReturnType<typeof clientModule.streamTextWithFallback>;
    });

    const messages: ChatMessage[] = [
      { id: "u-1", role: "user", content: "Plan a workstation build", parts: [{ type: "text", text: "Plan a workstation build" }] },
      { id: "a-1", role: "assistant", content: "Analyzing requirements...", parts: [{ type: "text", text: "Analyzing requirements..." }] }
    ];

    const streamResult = await streamChat(testConfig, messages, "sess-hosted-e2e");
    expect(streamResult).toBeDefined();
    expect(prepareStepFn).toBeDefined();

    // High token step in prepareStep (79% of contextLimit)
    const stepWithHighUsage = {
      usage: { promptTokens: 52_000, completionTokens: 300, totalTokens: 52_300 },
      toolResults: []
    };

    const longChatHistory = [
      { role: "user" as const, content: "Plan a workstation build with Threadripper. ".repeat(20) },
      { role: "assistant" as const, content: "Analyzing requirements for CAD and 3D rendering. ".repeat(20) }
    ];

    const prepareStepResult = await prepareStepFn!({
      steps: [stepWithHighUsage],
      messages: longChatHistory
    });

    expect(prepareStepResult.messages).toBeDefined();

    // Verify session database was NEVER touched in hosted mode
    expect(getSessionsDbSpy).not.toHaveBeenCalled();
    expect(getSessionSpy).not.toHaveBeenCalled();
    expect(saveSessionSpy).not.toHaveBeenCalled();
    expect(setCompactingSpy).not.toHaveBeenCalled();
  });

  it("Integration 3: Proves latest user request and search shortlist survive round-trip through compaction", async () => {
    // Generate compact context with search shortlist and user prompts
    const fixtureModelMessages: (import("ai").ModelMessage)[] = [
      { role: "user", content: "First query: Need a 1440p gaming rig" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Found RTX 4070 Super and checked motherboard compatibility. ".repeat(25) },
          {
            type: "tool-call",
            toolCallId: "call-gpu-1",
            toolName: "search_products",
            input: { category: "gpu" }
          }
        ]
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "call-gpu-1",
            toolName: "search_products",
            output: {
              type: "json",
              value: {
                results: [
                  { id: "gpu-4070-super", category: "gpu", name: "RTX 4070 Super 12GB", price: 59999 }
                ]
              }
            }
          }
        ]
      },
      { role: "user" as const, content: "Latest query: Can we switch to a fractal north case?" }
    ];

    const compactResult = await compactionModule.compactConversation({
      chain: geminiChain,
      systemPrompt: "You are PCBuildSage.",
      messages: fixtureModelMessages,
      contextLimit: 65536,
      force: true
    });

    expect(compactResult.compacted).toBe(true);
    expect(compactResult.messages).toHaveLength(3); // strictly alternating [user, assistant, user]
    expect(compactResult.messages[0].role).toBe("user");
    expect(compactResult.messages[1].role).toBe("assistant");
    expect(compactResult.messages[2].role).toBe("user");

    // Verify first prompt preserved word-for-word in message 0
    expect(compactResult.messages[0].content).toContain("First query: Need a 1440p gaming rig");

    // Verify latest prompt preserved word-for-word in message 2
    expect(compactResult.messages[2].content).toContain("Latest query: Can we switch to a fractal north case?");

    // Verify search shortlist was extracted from tool calls
    const shortlist = compactionModule.extractRecentSearchShortlist(fixtureModelMessages);
    expect(shortlist).toHaveLength(1);
    expect(shortlist[0].id).toBe("gpu-4070-super");
    expect(shortlist[0].name).toBe("RTX 4070 Super 12GB");
    expect(shortlist[0].price).toBe(59999);

    // Verify search shortlist survives directly in the synthetic user message
    expect(compactResult.messages[2].content).toContain("gpu-4070-super");
    expect(compactResult.messages[2].content).toContain("RTX 4070 Super 12GB");
    expect(compactResult.messages[2].content).toContain("59999");
  });

  it("Integration 4: Proves next turn does NOT re-fire compaction", async () => {
    let capturedPrepareStep: ((opts: { steps: unknown[]; messages: unknown[] }) => Promise<{ messages?: unknown[] }>) | undefined;
    let initialMessagesSentToModel: unknown[] = [];

    vi.mocked(clientModule.streamTextWithFallback).mockImplementation(async (opts: unknown) => {
      const options = opts as {
        messages: unknown[];
        prepareStep?: (opts: { steps: unknown[]; messages: unknown[] }) => Promise<{ messages?: unknown[] }>;
      };
      capturedPrepareStep = options.prepareStep;
      initialMessagesSentToModel = options.messages;

      return {
        toUIMessageStreamResponse: () => new Response("ok"),
        provider: "gemini",
        model: "gemini-2.0-flash",
        fallbackIndex: 0,
        errors: []
      } as unknown as ReturnType<typeof clientModule.streamTextWithFallback>;
    });

    const compactSpy = vi.spyOn(compactionModule, "compactConversation");

    // Turn 1 had assistant response msg 'asst-1'
    const compactContext: sessionsModule.StoredCompactContext = {
      messages: [
        { role: "user", content: "Original request" },
        { role: "assistant", content: "[Progress & Handoff Summary]\nSummary text." }
      ],
      boundaryMessageId: "asst-1",
      snapshot: null
    };

    // Client sends history including Turn 1 and Turn 2 user message
    const turn2History: ChatMessage[] = [
      { id: "user-1", role: "user", content: "Original request", parts: [{ type: "text", text: "Original request" }] },
      { id: "asst-1", role: "assistant", content: "Summary text.", parts: [{ type: "text", text: "Summary text." }] },
      { id: "user-2", role: "user", content: "Add 32GB RAM", parts: [{ type: "text", text: "Add 32GB RAM" }] }
    ];

    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    await streamChat(testConfig, turn2History, "sess-turn-2", undefined, compactContext);

    // Initial messages sent to model must ONLY be the 2 compact messages + turn 2 user message
    expect(initialMessagesSentToModel).toHaveLength(3);

    // Check prepareStep with a normal step token count (e.g. 1500 tokens)
    expect(capturedPrepareStep).toBeDefined();
    const stepNormalUsage = {
      usage: { promptTokens: 1500, completionTokens: 100, totalTokens: 1600 },
      toolResults: []
    };

    const stepResult = await capturedPrepareStep!({
      steps: [stepNormalUsage],
      messages: initialMessagesSentToModel as never
    });

    // Compaction must NOT have re-fired
    expect(stepResult?.messages).toBeUndefined();
    expect(compactSpy).not.toHaveBeenCalled();
  });

  it("Integration 4b: The next stored context keeps this turn's user question, not just the reply", async () => {
    let capturedOnFinish: ((finish: { text: string; model: { provider: string; modelId: string } }) => Promise<void>) | undefined;
    vi.mocked(clientModule.streamTextWithFallback).mockImplementation(async (opts: unknown) => {
      capturedOnFinish = (opts as { onFinish?: typeof capturedOnFinish }).onFinish;
      return {
        toUIMessageStreamResponse: () => new Response("ok"),
        provider: "gemini",
        model: "gemini-2.0-flash",
        fallbackIndex: 0,
        errors: []
      } as unknown as ReturnType<typeof clientModule.streamTextWithFallback>;
    });

    const compactContext: sessionsModule.StoredCompactContext = {
      messages: [
        { role: "user", content: "Original request" },
        { role: "assistant", content: "[Progress & Handoff Summary]\nSummary text." }
      ],
      boundaryMessageId: "asst-1",
      snapshot: null
    };
    const turn2History: ChatMessage[] = [
      { id: "user-1", role: "user", content: "Original request", parts: [{ type: "text", text: "Original request" }] },
      { id: "asst-1", role: "assistant", content: "Summary text.", parts: [{ type: "text", text: "Summary text." }] },
      { id: "user-2", role: "user", content: "Add 32GB RAM", parts: [{ type: "text", text: "Add 32GB RAM" }] }
    ];

    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    const result = await streamChat(testConfig, turn2History, "sess-turn-2b", undefined, compactContext, "asst-2");
    await capturedOnFinish!({ text: "Added a 2x16GB kit.", model: { provider: "gemini", modelId: "gemini-2.0-flash" } });

    const stored = result.compactContext!;
    const text = JSON.stringify(stored.messages);
    expect(text).toContain("Add 32GB RAM");
    expect(text).toContain("Added a 2x16GB kit.");
    expect(stored.messages.at(-1)).toMatchObject({ role: "assistant" });
    expect(stored.boundaryMessageId).toBe("asst-2");
  });

  it("Integration 5: Proves an old session from browser IndexedDB (without compacted context) still loads and chats normally", async () => {
    // Legacy session representation as stored in IndexedDB before this feature
    const legacyStoredSession = {
      id: "sess-legacy-123",
      title: "Older PC Build",
      created_at: "2026-01-01T10:00:00.000Z",
      updated_at: "2026-01-01T10:05:00.000Z",
      messages: [
        { id: "msg-1", role: "user", content: "What is a good power supply?" },
        { id: "msg-2", role: "assistant", content: "Corsair RM750e is reliable." }
      ],
      build_state: null,
      compact_context: null // Old sessions have null or undefined compact_context
    };

    let streamMessagesSent: unknown[] = [];
    vi.mocked(clientModule.streamTextWithFallback).mockImplementation(async (opts: unknown) => {
      const options = opts as { messages: unknown[] };
      streamMessagesSent = options.messages;
      return {
        toUIMessageStreamResponse: () => new Response("ok"),
        provider: "gemini",
        model: "gemini-2.0-flash",
        fallbackIndex: 0,
        errors: []
      } as unknown as ReturnType<typeof clientModule.streamTextWithFallback>;
    });

    // Resuming chat from legacy session: passes stored messages and null/undefined compactContext
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    await streamChat(
      testConfig,
      legacyStoredSession.messages as unknown as ChatMessage[],
      legacyStoredSession.id,
      undefined,
      legacyStoredSession.compact_context ?? undefined
    );

    // Verify all original messages are loaded without crashing or losing data
    expect(streamMessagesSent).toHaveLength(2);
    expect((streamMessagesSent[0] as { role: string }).role).toBe("user");
    expect((streamMessagesSent[1] as { role: string }).role).toBe("assistant");
  });

  it("Integration 6: Confirms the step cap remains isStepCount(25)", async () => {
    let capturedStopWhen: unknown;

    vi.mocked(clientModule.streamTextWithFallback).mockImplementation(async (opts: unknown) => {
      const options = opts as { stopWhen?: unknown };
      capturedStopWhen = options.stopWhen;
      return {
        toUIMessageStreamResponse: () => new Response("ok"),
        provider: "gemini",
        model: "gemini-2.0-flash",
        fallbackIndex: 0,
        errors: []
      } as unknown as ReturnType<typeof clientModule.streamTextWithFallback>;
    });

    await streamChat(testConfig, [{ id: "1", role: "user", content: "Hello", parts: [{ type: "text", text: "Hello" }] }]);

    expect(capturedStopWhen).toBeDefined();
    // Test the stopWhen predicate behavior at 24 vs 25 steps
    const stopCondition = capturedStopWhen as (context: { steps: unknown[] }) => boolean;
    const fakeSteps24 = Array.from({ length: 24 }, (_, i) => ({ step: i }));
    const fakeSteps25 = Array.from({ length: 25 }, (_, i) => ({ step: i }));

    expect(stopCondition({ steps: fakeSteps24 })).toBe(false);
    expect(stopCondition({ steps: fakeSteps25 })).toBe(true);
  });

  it("Integration 7: Confirms /api/sessions behavior for local mode is unchanged", async () => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "local";

    const testSessionId = `sess-api-check-${Date.now()}`;
    const testSessionData = {
      id: testSessionId,
      revision: 0,
      title: "API Local Check",
      messages: [{ id: "m-1", role: "user", content: "Test" }],
      country_code: "IN",
      currency: "INR"
    };

    // 1. POST /api/sessions
    const postReq = new Request("http://localhost:3000/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(testSessionData)
    });
    const postRes = await sessionsPost(postReq);
    expect(postRes.status).toBe(200);
    const postJson = await postRes.json();
    expect(postJson.ok).toBe(true);

    // 2. GET /api/sessions
    const listReq = new Request("http://localhost:3000/api/sessions");
    const listRes = await sessionsGet(listReq);
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    expect(Array.isArray(listJson.sessions)).toBe(true);
    const found = listJson.sessions.find((s: { id: string }) => s.id === testSessionId);
    expect(found).toBeDefined();
    expect(found.title).toBe("API Local Check");

    // 3. GET /api/sessions/:id
    const detailReq = new Request(`http://localhost:3000/api/sessions/${testSessionId}`);
    const detailRes = await sessionDetailGet(detailReq, { params: Promise.resolve({ id: testSessionId }) });
    expect(detailRes.status).toBe(200);
    const detailJson = await detailRes.json();
    expect(detailJson.session).toBeDefined();
    expect(detailJson.session.id).toBe(testSessionId);
  });
});
