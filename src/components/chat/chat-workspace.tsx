"use client";

import { useCallback, useEffect, useState } from "react";
import { deleteSession, fetchSession, fetchSessions } from "../lib/api";
import type { ClientConfig, SessionSummary } from "../lib/types";
import { ChatView } from "./chat-view";
import type { ChatUIMessage } from "./message";
import { ChatSidebar } from "./chat-sidebar";
import { AppShell } from "../app/app-shell";
import { SidebarProvider, SidebarTrigger, useSidebar } from "@/components/animate-ui/components/radix/sidebar";

// Neutral hover for the header menu trigger (base shadcn ghost Button):
// twMerge overrides the component's default green `hover:bg-accent`.
const TRIGGER_HOVER = "hover:bg-surface-raised hover:text-text";

/**
 * Header toggle that stays out of the way when the desktop sidebar is already
 * expanded (its in-sidebar trigger handles collapsing there), and appears on
 * mobile or whenever the desktop rail is collapsed so there's always a visible
 * way to reopen it.
 */
function HeaderSidebarTrigger() {
  const { state, isMobile } = useSidebar();
  if (!isMobile && state === "expanded") return null;
  return <SidebarTrigger className={TRIGGER_HOVER} />;
}

/**
 * Owns chat-session state (current id, the history list, and the messages to
 * hydrate) and renders the history sidebar alongside a keyed <ChatView>, so
 * switching sessions cleanly remounts useChat. The whole shell is wrapped in
 * SidebarProvider so both the sidebar and the mobile trigger share its context.
 */
export function ChatWorkspace({ config }: { config: ClientConfig }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>(() => crypto.randomUUID());
  const [initialMessages, setInitialMessages] = useState<ChatUIMessage[]>([]);

  const refresh = useCallback(() => {
    fetchSessions()
      .then(setSessions)
      .catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleNew = useCallback(() => {
    setInitialMessages([]);
    setCurrentSessionId(crypto.randomUUID());
  }, []);

  const handleSelect = useCallback(
    async (id: string) => {
      if (id === currentSessionId) return;
      const session = await fetchSession(id).catch(() => null);
      setInitialMessages(session?.messages ?? []);
      setCurrentSessionId(id);
    },
    [currentSessionId]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteSession(id).catch(() => {});
      if (id === currentSessionId) {
        setInitialMessages([]);
        setCurrentSessionId(crypto.randomUUID());
      }
      refresh();
    },
    [currentSessionId, refresh]
  );

  return (
    <SidebarProvider>
      <AppShell
        sidebar={
          <ChatSidebar
            sessions={sessions}
            currentSessionId={currentSessionId}
            onNew={handleNew}
            onSelect={handleSelect}
            onDelete={handleDelete}
          />
        }
        actions={<HeaderSidebarTrigger />}
      >
        <ChatView
          key={currentSessionId}
          config={config}
          sessionId={currentSessionId}
          initialMessages={initialMessages}
          onPersisted={refresh}
        />
      </AppShell>
    </SidebarProvider>
  );
}
