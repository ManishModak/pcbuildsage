"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { deleteSession, fetchSession, fetchSessions, saveSession } from "@/lib/api-client";
import type { ClientConfig, SessionSummary } from "@/types/client";
import { ChatView } from "./chat-view";
import type { ChatUIMessage } from "./message";
import { ChatSidebar } from "./chat-sidebar";
import { AppShell } from "@/components/app/app-shell";
import { SidebarProvider, SidebarTrigger, useSidebar } from "@/components/animate-ui/components/radix/sidebar";
import {
  applySessionSelection,
  chatViewKey,
  decideOpenAction,
  invalidateSessionSelection,
  MAX_ACTIVE_SESSIONS,
  selectLatestSession,
  shrinkSessionPool,
  type PoolEntry
} from "./session-selection";
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
 * One open chat tab. `isStreaming` is reported by `ChatView`: a streaming entry
 * is never evicted, because dropping it would unmount the view and kill the reply
 * mid-flight. `isLoading` is true while its messages are still being fetched.
 */
type ActiveSessionEntry = PoolEntry<SessionSaveQueue>;

/**
 * Build the save queue for a session. Every queue can resolve a revision
 * conflict by asking for the authoritative copy, so a second tab never gets its
 * work clobbered by a blind rebase.
 */
function createSaveQueue(
  id: string,
  messages: ChatUIMessage[],
  revision: number,
  onPersisted: () => void
): SessionSaveQueue {
  return new SessionSaveQueue(saveSession, sessionSignature(messages), revision, onPersisted, {
    loadServerCopy: async () => {
      const session = await fetchSession(id);
      return session
        ? {
            revision: session.revision,
            messages: session.messages,
            // Carried with the transcript: a compacted context summarises specific
            // messages, so adopting the transcript alone would leave this tab saving
            // a summary of the wrong conversation.
            compactContext: session.compact_context ?? null
          }
        : null;
    }
  });
}

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
      lastActiveAt: Date.now(),
      isStreaming: false
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
  /** Ids dropped from the pool, drained by the effect that frees their queues. */
  const releasedIdsRef = useRef(new Set<string>());

  /**
   * True only until the first list settles. Later refreshes (after a save or a
   * delete) deliberately do not re-enter the loading state: the list is already
   * on screen and flashing "Loading chats…" over it would be worse than nothing.
   */
  const [isSessionsLoading, setIsSessionsLoading] = useState(true);

  const refresh = useCallback(() => {
    return fetchSessions()
      .then((list) => {
        setSessions(list);
        setIsSessionsLoading(false);
      })
      .catch(() => {
        // A transient history-list failure must not erase the last known list.
        setIsSessionsLoading(false);
      });
  }, []);

  const activateSessionInPool = useCallback(
    (id: string, messages: ChatUIMessage[], revision = 0, loaded = true, pendingLoad = false) => {
      let queue = saveQueuesRef.current.get(id);
      if (!queue) {
        queue = createSaveQueue(id, messages, revision, refresh);
        saveQueuesRef.current.set(id, queue);
      } else if (loaded) {
        queue.observeLoaded(sessionSignature(messages), revision);
      } else {
        queue.observeRevision(revision);
      }

      setActiveSessions((prev) => {
        const selection = applySessionSelection({
          pool: prev,
          currentSessionId: currentSessionIdRef.current,
          id,
          loaded,
          messages,
          pendingLoad,
          newEntry: { id, queue, isStreaming: false, lastActiveAt: Date.now() }
        });
        if (selection.evictedId) releasedIdsRef.current.add(selection.evictedId);
        return selection.pool;
      });

      setCurrentSessionId(id);
    },
    [refresh]
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * A `SessionSaveQueue` holds its `acknowledgedSignature`, which is a full
   * `JSON.stringify` of the transcript - roughly half a megabyte per long chat.
   * Eight evicted queues that are never released would pin that memory until a
   * reload, so an evicted id drops its queue.
   *
   * `chooseEvictionIndex` only ever evicts an idle entry, so this can never yank a
   * live stream's queue: a streaming chat stays in the pool until it finishes.
   */
  useEffect(() => {
    if (releasedIdsRef.current.size === 0) return;
    for (const id of releasedIdsRef.current) {
      saveQueuesRef.current.delete(id);
    }
    releasedIdsRef.current.clear();
  }, [activeSessions]);

  const handleStreamingChange = useCallback((id: string, isStreaming: boolean) => {
    setActiveSessions((prev) => {
      const index = prev.findIndex((s) => s.id === id);
      if (index === -1) return prev;
      let updated = prev;
      if (prev[index].isStreaming !== isStreaming) {
        updated = [...prev];
        updated[index] = { ...updated[index], isStreaming };
      }
      // A stream just ended while the pool was over its cap: the grace that let
      // it grow (never evict a live stream) no longer applies, so shrink back
      // to idle entries. The shrink only ever evicts idle, non-current entries.
      if (updated.length > MAX_ACTIVE_SESSIONS) {
        const shrunk = shrinkSessionPool({ pool: updated, currentSessionId: currentSessionIdRef.current });
        if (shrunk.evictedIds.length > 0) {
          for (const evictedId of shrunk.evictedIds) releasedIdsRef.current.add(evictedId);
          return shrunk.pool;
        }
      }
      return updated;
    });
  }, []);

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
      if (decideOpenAction(existing) === "switch") {
        // Already open in another tab: switch to it as it is, keeping its messages
        // and any stream in progress. A loading entry here is one whose fetch has
        // not landed yet.
        invalidateSessionSelection(selectionGuardRef.current);
        setActiveSessions((prev) =>
          prev.map((s) => (s.id === id ? { ...s, lastActiveAt: Date.now() } : s))
        );
        setCurrentSessionId(id);
        return;
      }

      // Either the chat is not open, or it is open but its load failed (the user was
      // switched away mid-fetch). Both need a real fetch, and both must show the
      // loading state rather than the new-chat screen.
      const refetching = existing !== undefined;
      if (!refetching) {
        saveQueuesRef.current.set(id, createSaveQueue(id, [], 0, refresh));
      }
      activateSessionInPool(id, [], 0, false, refetching);

      const loaded = await selectLatestSession(selectionGuardRef.current, id, fetchSession, (session) => {
        activateSessionInPool(session.id, session.messages, session.revision, true);
      });
      if (loaded) return;

      // The fetch failed or there is no such chat: stop pretending to load and
      // leave this tab genuinely empty. Clicking it again re-fetches, because an
      // empty, idle entry is exactly what decideOpenAction treats as a failure.
      setActiveSessions((prev) => prev.map((s) => (s.id === id ? { ...s, isLoading: false } : s)));
    },
    [activateSessionInPool, refresh]
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
            lastActiveAt: Date.now(),
            isStreaming: false,
            isLoading: false
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
            isLoading={isSessionsLoading}
          />
        }
        actions={<HeaderSidebarTrigger />}
      >
        <div className="relative flex flex-1 h-full w-full min-w-0">
          {activeSessions.map((session) => (
            <div
              key={chatViewKey(session)}
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
                onStreamingChange={handleStreamingChange}
                isLoading={session.isLoading === true}
              />
            </div>
          ))}
        </div>
      </AppShell>
    </SidebarProvider>
  );
}
