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
