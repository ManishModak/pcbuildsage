"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { deleteSession, fetchSession, fetchSessions, saveSession } from "@/lib/api-client";
import type { ClientConfig, SessionSummary } from "@/types/client";
import { ChatView } from "./chat-view";
import type { ChatUIMessage } from "./message";
import { ChatSidebar } from "./chat-sidebar";
import { AppShell } from "@/components/app/app-shell";
import { SidebarProvider, SidebarTrigger, useSidebar } from "@/components/animate-ui/components/radix/sidebar";
import { invalidateSessionSelection, selectLatestSession } from "./session-selection";
import { SessionSaveQueue, sessionSignature } from "./session-save-queue";

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
  const [initialSession] = useState(() => {
    const id = crypto.randomUUID();
    const messages: ChatUIMessage[] = [];
    return {
      id,
      messages,
      queue: new SessionSaveQueue(saveSession, sessionSignature(messages)),
    };
  });
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState(initialSession.id);
  const [initialMessages, setInitialMessages] = useState(initialSession.messages);
  const [saveQueue, setSaveQueue] = useState(initialSession.queue);
  const currentSessionIdRef = useRef(currentSessionId);
  const selectionGuardRef = useRef({ generation: 0 });
  const saveQueuesRef = useRef(new Map([[initialSession.id, initialSession.queue]]));

  const commitSession = useCallback((id: string, messages: ChatUIMessage[], revision = 0) => {
    let queue = saveQueuesRef.current.get(id);
    if (!queue) {
      queue = new SessionSaveQueue(saveSession, sessionSignature(messages), revision);
      saveQueuesRef.current.set(id, queue);
    } else {
      queue.observeRevision(revision);
    }
    currentSessionIdRef.current = id;
    setInitialMessages(messages);
    setSaveQueue(queue);
    setCurrentSessionId(id);
  }, []);

  const refresh = useCallback(() => {
    fetchSessions()
      .then(setSessions)
      .catch(() => {
        // A transient history-list failure must not erase the last known list.
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleNew = useCallback(() => {
    invalidateSessionSelection(selectionGuardRef.current);
    commitSession(crypto.randomUUID(), []);
  }, [commitSession]);

  const handleSelect = useCallback(
    async (id: string) => {
      if (id === currentSessionIdRef.current) {
        invalidateSessionSelection(selectionGuardRef.current);
        return;
      }
      await selectLatestSession(selectionGuardRef.current, id, fetchSession, (session) => {
        commitSession(session.id, session.messages, session.revision);
      });
    },
    [commitSession]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deleteSession(id);
      } catch {
        return;
      }
      invalidateSessionSelection(selectionGuardRef.current);
      if (id === currentSessionIdRef.current) {
        commitSession(crypto.randomUUID(), []);
      }
      saveQueuesRef.current.delete(id);
      refresh();
    },
    [commitSession, refresh]
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
          saveQueue={saveQueue}
          onPersisted={refresh}
        />
      </AppShell>
    </SidebarProvider>
  );
}
