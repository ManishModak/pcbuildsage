import type { SessionDetail } from "@/lib/api-client";

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
