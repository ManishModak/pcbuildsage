import type { BuildSnapshot } from "@/lib/catalog/build-snapshot";

// Reading full build snapshots out of validate_build outputs. Kept free of
// server imports: messages.ts (loaded in the browser) and compaction.ts share it.

/**
 * True for a whole BuildSnapshot. validate_build's model view (what tool
 * results in model messages hold) keeps only total and components, which the
 * snapshot formatter can't summarize; those are skipped for the full
 * snapshots the caller passes.
 */
function isFullSnapshot(value: unknown): value is BuildSnapshot {
  const s = value as Partial<BuildSnapshot> | null;
  return Boolean(s && typeof s === "object" && Array.isArray(s.components) && typeof s.currency === "string");
}

/** True when a validate_build output carries builds or a snapshot, full or trimmed. */
export function hasBuildData(output: unknown): boolean {
  const obj = output as { builds?: unknown; snapshot?: unknown } | null;
  return Boolean(obj && typeof obj === "object" && ((obj.builds && typeof obj.builds === "object") || (obj.snapshot && typeof obj.snapshot === "object")));
}

/**
 * The full snapshot of every build in a validate_build output (builds keyed by
 * label or listed, else its top-level snapshot), unwrapping a {type, value}
 * tool output. Trimmed model-view snapshots are left out (see isFullSnapshot).
 */
export function fullSnapshotsOf(rawOutput: unknown): BuildSnapshot[] {
  const output = rawOutput && typeof rawOutput === "object" && "value" in rawOutput ? (rawOutput as { value: unknown }).value : rawOutput;
  if (!output || typeof output !== "object") return [];
  const outObj = output as Record<string, unknown>;
  const builds = outObj.builds && typeof outObj.builds === "object" ? (Array.isArray(outObj.builds) ? outObj.builds : Object.values(outObj.builds)) : [];
  const snapshots: BuildSnapshot[] = [];
  for (const b of builds) {
    if (!b || typeof b !== "object") continue;
    if ("snapshot" in b && isFullSnapshot(b.snapshot)) snapshots.push(b.snapshot);
    else if (isFullSnapshot(b)) snapshots.push(b);
  }
  if (snapshots.length === 0 && isFullSnapshot(outObj.snapshot)) snapshots.push(outObj.snapshot);
  return snapshots;
}
