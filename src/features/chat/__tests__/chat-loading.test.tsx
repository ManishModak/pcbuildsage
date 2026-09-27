import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AppProvider } from "@/components/app/app-provider";
import type { ClientConfig } from "@/types/client";
import { DEFAULT_CONFIG } from "@/lib/client-config-store";
import { applySessionSelection, type PoolEntry } from "../session-selection";
import { SessionSaveQueue, sessionSignature } from "../session-save-queue";
import type { ChatUIMessage } from "../message";

/**
 * The chat's messages come from `useChat`; this suite is about which of the
 * three states (loading / empty / loaded) the view renders, so the hook is
 * stubbed with a fixed, empty transcript.
 */
const chatState = { messages: [] as ChatUIMessage[] };

vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: chatState.messages,
    sendMessage: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    error: undefined,
    setMessages: () => {}
  })
}));

const { ChatView } = await import("../chat-view");
const { ChatSidebar } = await import("../chat-sidebar");
const { SidebarProvider } = await import("@/components/animate-ui/components/radix/sidebar");

const config: ClientConfig = { ...DEFAULT_CONFIG, currency: "INR", countryCode: "IN" };

function noSleep() {
  return Promise.resolve();
}

function makeQueue(messages: ChatUIMessage[] = []) {
  return new SessionSaveQueue(async () => {}, sessionSignature(messages), 0, () => {}, { sleep: noSleep });
}

function userMessage(text: string): ChatUIMessage {
  return { id: `m-${text}`, role: "user", parts: [{ type: "text", text }] } as ChatUIMessage;
}

/** Markup of the chat the user is actually looking at. */
function renderVisibleChat(overrides: { isLoading?: boolean; messages?: ChatUIMessage[] } = {}) {
  return renderToStaticMarkup(
    <AppProvider>
      <ChatView
        config={config}
        sessionId="session-b"
        initialMessages={overrides.messages ?? []}
        saveQueue={makeQueue(overrides.messages ?? [])}
        isLoading={overrides.isLoading}
      />
    </AppProvider>
  );
}

describe("ChatView loading state", () => {
  it("shows a loading status instead of the new-chat screen while a chat is being fetched", () => {
    const markup = renderVisibleChat({ isLoading: true });

    expect(markup).toContain("Loading chat");
    expect(markup).toContain('role="status"');
    // ChatEmptyState's copy, which is indistinguishable from a genuinely new chat.
    expect(markup).not.toContain("What are we building?");
  });

  it("still renders the new-chat screen when isLoading is absent (old behaviour preserved)", () => {
    const markup = renderVisibleChat();

    expect(markup).toContain("What are we building?");
    expect(markup).not.toContain("Loading chat");
  });

  it("cannot be messaged into while loading", () => {
    expect(renderVisibleChat({ isLoading: true })).toMatch(/<textarea[^>]*disabled/);
    expect(renderVisibleChat()).not.toMatch(/<textarea[^>]*disabled/);
  });

  it("never shows the previous chat's messages when the workspace switches to an uncached chat", () => {
    const chatAMessages = [userMessage("secret chat A content about a 7800X3D build")];
    const pool: PoolEntry<SessionSaveQueue>[] = [
      {
        id: "session-a",
        messages: chatAMessages,
        queue: makeQueue(chatAMessages),
        lastActiveAt: 100,
        isStreaming: false,
        isLoading: false
      }
    ];

    // The switch: session B is not cached, so it enters the pool empty + loading.
    const { pool: next, currentId } = applySessionSelection({
      pool,
      currentSessionId: "session-a",
      id: "session-b",
      loaded: false,
      messages: [],
      newEntry: { id: "session-b", queue: makeQueue(), isStreaming: false, lastActiveAt: 0 }
    });
    expect(currentId).toBe("session-b");

    // Render the chat the user is now looking at, exactly as the workspace does.
    const current = next.find((entry) => entry.id === currentId)!;
    const markup = renderToStaticMarkup(
      <AppProvider>
        <ChatView
          config={config}
          sessionId={current.id}
          initialMessages={current.messages}
          saveQueue={current.queue}
          isLoading={current.isLoading === true}
        />
      </AppProvider>
    );

    expect(markup).toContain("Loading chat");
    expect(markup).not.toContain("secret chat A content");
    expect(markup).not.toContain("What are we building?");
    expect(markup).toMatch(/<textarea[^>]*disabled/);
  });
});

describe("ChatSidebar loading state", () => {
  function renderSidebar(isLoading?: boolean) {
    return renderToStaticMarkup(
      <AppProvider>
        <SidebarProvider>
          <ChatSidebar
            sessions={[]}
            currentSessionId="session-1"
            onNew={() => {}}
            onSelect={() => {}}
            onDelete={() => {}}
            isLoading={isLoading}
          />
        </SidebarProvider>
      </AppProvider>
    );
  }

  it("shows a loading status instead of 'No saved chats yet' while the list is in flight", () => {
    const markup = renderSidebar(true);

    expect(markup).toContain("Loading chats");
    expect(markup).not.toContain("No saved chats yet");
  });

  it("still shows 'No saved chats yet' when isLoading is absent (old behaviour preserved)", () => {
    const markup = renderSidebar();

    expect(markup).toContain("No saved chats yet");
    expect(markup).not.toContain("Loading chats");
  });
});
