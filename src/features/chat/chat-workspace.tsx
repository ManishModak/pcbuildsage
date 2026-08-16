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

interface ActiveSessionEntry {
  id: string;
  messages: ChatUIMessage[];
  queue: SessionSaveQueue;
  lastActiveAt: number;
}

const MAX_ACTIVE_SESSIONS = 8;

/**
 * Owns chat-session state with Option A background multi-session streaming:
 * maintains a pool of active recent sessions rendered as concurrent tabs
 * (active tab flex, background tabs hidden). Switching chats preserves active
 * streams and avoids unmounting useChat.
 */
export function ChatWorkspace({ config }: { config: ClientConfig }) {
  const [initialEntry] = useState<ActiveSessionEntry>(() => {
    const id = crypto.randomUUID();
    const messages: ChatUIMessage[] = [];
    return {
      id,
      messages,
      queue: new SessionSaveQueue(saveSession, sessionSignature(messages)),
      lastActiveAt: Date.now()
    };
  });

  const [activeSessions, setActiveSessions] = useState<ActiveSessionEntry[]>([initialEntry]);
  const [currentSessionId, setCurrentSessionId] = useState<string>(initialEntry.id);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  const currentSessionIdRef = useRef(currentSessionId);
  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  const activeSessionsRef = useRef(activeSessions);
  useEffect(() => {
    activeSessionsRef.current = activeSessions;
  }, [activeSessions]);

  const selectionGuardRef = useRef({ generation: 0 });
  const saveQueuesRef = useRef(new Map<string, SessionSaveQueue>([[initialEntry.id, initialEntry.queue]]));

  const activateSessionInPool = useCallback((id: string, messages: ChatUIMessage[], revision = 0) => {
    let queue = saveQueuesRef.current.get(id);
    if (!queue) {
      queue = new SessionSaveQueue(saveSession, sessionSignature(messages), revision);
      saveQueuesRef.current.set(id, queue);
    } else {
      queue.observeRevision(revision);
    }

    const now = Date.now();
    setActiveSessions((prev) => {
      const existingIndex = prev.findIndex((s) => s.id === id);
      if (existingIndex !== -1) {
        const updated = [...prev];
        updated[existingIndex] = {
          ...updated[existingIndex],
          lastActiveAt: now
        };
        return updated;
      }

      let nextList = prev;
      if (nextList.length >= MAX_ACTIVE_SESSIONS) {
        const currentActive = currentSessionIdRef.current;
        let oldestIndex = -1;
        let oldestTime = Infinity;
        for (let i = 0; i < nextList.length; i++) {
          const item = nextList[i];
          if (item.id !== currentActive && item.lastActiveAt < oldestTime) {
            oldestTime = item.lastActiveAt;
            oldestIndex = i;
          }
        }
        if (oldestIndex !== -1) {
          nextList = nextList.filter((_, i) => i !== oldestIndex);
        }
      }

      return [...nextList, { id, messages, queue, lastActiveAt: now }];
    });

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
    const newId = crypto.randomUUID();
    activateSessionInPool(newId, []);
  }, [activateSessionInPool]);

  const handleSelect = useCallback(
    async (id: string) => {
      if (id === currentSessionIdRef.current) {
        invalidateSessionSelection(selectionGuardRef.current);
        return;
      }

      const existing = activeSessionsRef.current.find((s) => s.id === id);
      if (existing) {
        invalidateSessionSelection(selectionGuardRef.current);
        const now = Date.now();
        setActiveSessions((prev) =>
          prev.map((s) => (s.id === id ? { ...s, lastActiveAt: now } : s))
        );
        setCurrentSessionId(id);
        return;
      }

      await selectLatestSession(selectionGuardRef.current, id, fetchSession, (session) => {
        activateSessionInPool(session.id, session.messages, session.revision);
      });
    },
    [activateSessionInPool]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deleteSession(id);
      } catch {
        return;
      }
      invalidateSessionSelection(selectionGuardRef.current);
      saveQueuesRef.current.delete(id);

      setActiveSessions((prev) => {
        const filtered = prev.filter((s) => s.id !== id);
        if (filtered.length === 0) {
          const newId = crypto.randomUUID();
          const messages: ChatUIMessage[] = [];
          const newQueue = new SessionSaveQueue(saveSession, sessionSignature(messages));
          saveQueuesRef.current.set(newId, newQueue);
          const newEntry: ActiveSessionEntry = {
            id: newId,
            messages,
            queue: newQueue,
            lastActiveAt: Date.now()
          };
          setCurrentSessionId(newId);
          return [newEntry];
        }

        if (id === currentSessionIdRef.current) {
          const mostRecent = [...filtered].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
          setCurrentSessionId(mostRecent.id);
        }

        return filtered;
      });

      refresh();
    },
    [refresh]
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
        <div className="relative flex flex-1 h-full w-full min-w-0">
          {activeSessions.map((session) => (
            <div
              key={session.id}
              className={
                session.id === currentSessionId
                  ? "flex flex-1 h-full w-full min-w-0"
                  : "hidden"
              }
            >
              <ChatView
                config={config}
                sessionId={session.id}
                initialMessages={session.messages}
                saveQueue={session.queue}
                onPersisted={refresh}
                isActive={session.id === currentSessionId}
              />
            </div>
          ))}
        </div>
      </AppShell>
    </SidebarProvider>
  );
}
