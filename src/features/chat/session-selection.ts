import type { SessionDetail } from "@/lib/api-client";
import type { ChatUIMessage } from "./message";

export type SessionSelectionGuard = { generation: number };

export function invalidateSessionSelection(guard: SessionSelectionGuard): void {
  guard.generation += 1;
}

/** Load a session without allowing an older request to replace a newer choice. */
export async function selectLatestSession(
  guard: SessionSelectionGuard,
  id: string,
  load: (id: string) => Promise<SessionDetail | null>,
  commit: (session: SessionDetail) => void
): Promise<boolean> {
  const generation = ++guard.generation;
  try {
    const session = await load(id);
    if (!session || generation !== guard.generation) return false;
    commit(session);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Active-session pool eviction
// ---------------------------------------------------------------------------

/** The pool entry fields the eviction decision needs. */
export type EvictableSession = {
  id: string;
  lastActiveAt: number;
  isStreaming?: boolean;
};

/**
 * Index of the entry to drop when the pool is full, or -1 to keep everything.
 *
 * Evicting an entry unmounts its `ChatView`, which kills that chat's stream and
 * loses the partial reply. A session that is still streaming is therefore never
 * a candidate, and when every non-current entry is streaming the pool is allowed
 * to go over the cap — an extra tab is a far smaller problem than silently
 * cutting off a reply in progress.
 */
export function chooseEvictionIndex(
  entries: readonly EvictableSession[],
  currentId: string
): number {
  let candidateIndex = -1;
  let oldestTime = Infinity;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.id === currentId) continue;
    if (entry.isStreaming) continue;
    if (entry.lastActiveAt < oldestTime) {
      oldestTime = entry.lastActiveAt;
      candidateIndex = i;
    }
  }
  return candidateIndex;
}

/** The cap the pool tries to stay under; it is exceeded rather than cut a stream short. */
export const MAX_ACTIVE_SESSIONS = 8;

/** One row of the active-session pool. `queue` is opaque here to keep this pure. */
export type PoolEntry<TQueue = unknown> = {
  id: string;
  messages: ChatUIMessage[];
  lastActiveAt: number;
  queue: TQueue;
  isStreaming?: boolean;
  /** True while the session is being fetched and has no messages yet. */
  isLoading?: boolean;
};

export type SessionSelection<TQueue> = {
  pool: PoolEntry<TQueue>[];
  currentId: string;
};

/**
 * The single pool transition behind clicking a chat in the sidebar.
 *
 * Two rules that are easy to get wrong and invisible once they are:
 *
 * - A chat that is **not already open** enters the pool with the loaded messages
 *   (or none) and a loading flag, in this one update. The previous chat's
 *   messages are never carried across, so the user cannot read - or type into -
 *   the wrong thread while the new one loads.
 * - A chat that is **already open** keeps its own messages and its live stream.
 *   Clicking back to a background tab must not blank a reply in progress.
 *
 * A failed or empty `fetchSession` clears the loading flag and leaves the chat
 * genuinely empty rather than stuck on a spinner.
 */
export function applySessionSelection<TQueue>(options: {
  pool: readonly PoolEntry<TQueue>[];
  currentSessionId: string;
  id: string;
  loaded: boolean;
  messages: ChatUIMessage[];
  /** The entry to add when the chat is not already open, minus messages/loading. */
  newEntry: Omit<PoolEntry<TQueue>, "messages" | "isLoading">;
  now?: number;
}): SessionSelection<TQueue> {
  const { pool, currentSessionId, id, loaded, messages, newEntry } = options;
  const now = options.now ?? Date.now();

  const existingIndex = pool.findIndex((entry) => entry.id === id);
  if (existingIndex !== -1) {
    const existing = pool[existingIndex];
    const next = [...pool];
    next[existingIndex] = {
      ...existing,
      // A completed load fills in the empty placeholder the pool was opened with.
      // An entry that already has messages keeps them: a failed refetch, or a
      // re-activation, must never blank a chat that is streaming.
      messages: loaded && existing.messages.length === 0 ? messages : existing.messages,
      lastActiveAt: now,
      isLoading: false
    };
    return { pool: next, currentId: id };
  }

  let next = pool;
  if (next.length >= MAX_ACTIVE_SESSIONS) {
    const evicted = chooseEvictionIndex(next, currentSessionId);
    if (evicted !== -1) next = next.filter((_, index) => index !== evicted);
  }

  const entry: PoolEntry<TQueue> = {
    ...newEntry,
    messages: loaded ? messages : [],
    lastActiveAt: now,
    isLoading: !loaded
  };
  return { pool: [...next, entry], currentId: id };
}
