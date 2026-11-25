// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AppProvider } from "@/components/app/app-provider";
import { DEFAULT_CONFIG } from "@/lib/client-config-store";
import { resetCachedDeploymentMode, setCachedDeploymentMode } from "@/lib/api-client";
import {
  resetByokStoreForTesting,
  setActiveByokProvider,
  setByokKey,
  setByokModel,
  setByokModelReasoningEffort,
  setByokStorageForTesting
} from "@/lib/llm/client-byok-store";
import { SessionSaveQueue } from "../session-save-queue";
import { ChatView } from "../chat-view";
import { RATE_LIMIT_RECOVERY_DELAY_MS } from "../chat-recovery";

class MockStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

describe("ChatView mid-turn model switch retry isolation", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetCachedDeploymentMode();
    resetByokStoreForTesting();
    setByokStorageForTesting(new MockStorage(), new MockStorage());
    setCachedDeploymentMode("hosted-demo");
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (root) {
      const mountedRoot = root;
      act(() => {
        mountedRoot.unmount();
      });
      root = null;
    }
    container?.remove();
    container = undefined;
    document.body.innerHTML = "";
  });

  it("keeps automatic rate-limit retries pinned to the submitted turn's model and credentials after switching models mid-turn", async () => {
    setByokKey("gemini", "AIzaSyTurnAKey");
    setByokKey("openai", "sk-TurnBPaidKey");
    setByokModel("gemini", "gemini-4-hydrogen");
    setByokModelReasoningEffort("gemini", "gemini-4-hydrogen", "high");
    setByokModel("openai", "gpt-5");
    setActiveByokProvider("gemini");

    const chatCalls: Array<{
      body: { config?: { chatLlmChain?: Array<{ provider: string; model: string; reasoningEffort?: string }> } };
      headers: Headers;
    }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/chat") {
          const parsedBody = JSON.parse(String(init?.body ?? "{}")) as {
            config?: { chatLlmChain?: Array<{ provider: string; model: string; reasoningEffort?: string }> };
          };
          chatCalls.push({
            body: parsedBody,
            headers: new Headers(init?.headers)
          });
          if (chatCalls.length === 1) {
            return new Response(JSON.stringify({ message: "HTTP 429 rate limit exceeded" }), {
              status: 429,
              headers: { "content-type": "application/json" }
            });
          }
          // Second attempt succeeds with an empty UI message SSE stream.
          return new Response("data: [DONE]\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" }
          });
        }
        return new Response(JSON.stringify({ status: "ok", mode: "hosted-demo", database: { exists: true, rowCounts: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      })
    );

    const saveQueue = new SessionSaveQueue(async () => {}, "[]");
    root = createRoot(container!);

    await act(async () => {
      root!.render(
        <AppProvider>
          <ChatView
            config={DEFAULT_CONFIG}
            sessionId="session-mid-turn"
            initialMessages={[]}
            saveQueue={saveQueue}
          />
        </AppProvider>
      );
      await Promise.resolve();
    });

    // Submit message on Model A (Gemini 4 Hydrogen, high).
    const textarea = container!.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "Suggest a 1080p gaming PC under 70k");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const sendBtn = container!.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;
    expect(sendBtn).not.toBeNull();
    expect(sendBtn.disabled).toBe(false);
    await act(async () => {
      sendBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0].body.config?.chatLlmChain?.[0]).toMatchObject({
      provider: "gemini",
      model: "gemini-4-hydrogen",
      reasoningEffort: "high"
    });
    expect(chatCalls[0].headers.get("x-pcbuildsage-api-key-gemini")).toBe("AIzaSyTurnAKey");
    expect(chatCalls[0].headers.get("x-pcbuildsage-api-key-openai")).toBeNull();

    // User switches to paid Model B (OpenAI gpt-5) while the rate-limit retry is pending.
    await act(async () => {
      setActiveByokProvider("openai");
      await Promise.resolve();
    });

    // Advance past the 10s rate-limit retry timer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_RECOVERY_DELAY_MS + 100);
      await Promise.resolve();
      await Promise.resolve();
    });

    // The automatic retry MUST still target Model A and MUST NOT send OpenAI's paid key.
    expect(chatCalls).toHaveLength(2);
    expect(chatCalls[1].body.config?.chatLlmChain?.[0]).toMatchObject({
      provider: "gemini",
      model: "gemini-4-hydrogen",
      reasoningEffort: "high"
    });
    expect(chatCalls[1].headers.get("x-pcbuildsage-api-key-gemini")).toBe("AIzaSyTurnAKey");
    expect(chatCalls[1].headers.get("x-pcbuildsage-api-key-openai")).toBeNull();
  });
});
