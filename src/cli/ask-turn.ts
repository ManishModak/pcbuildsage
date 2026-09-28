import type { BuildSnapshot } from "@/lib/catalog/build-snapshot";

/** A build the model showed via present_build, with its validated snapshot when known. */
export type PresentedBuild = {
  label: string;
  product_ids?: string[];
  notes?: string;
  snapshot?: BuildSnapshot;
};

/** What one `ask` turn produced: text, presented builds, and step count. */
export type AskTurn = {
  content: string;
  steps: number;
  builds: PresentedBuild[];
  /** Last stream error, if the provider failed mid-turn. */
  streamError?: string;
};

/** The fullStream parts the CLI reads (a structural subset of the SDK's TextStreamPart). */
export type AskStreamPart =
  | { type: "text-delta"; text: string }
  | { type: "tool-result"; toolName: string; output: unknown }
  | { type: "finish-step" }
  | { type: string; [key: string]: unknown };

function unwrap(output: unknown): unknown {
  return output && typeof output === "object" && "value" in output ? (output as { value: unknown }).value : output;
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * Accumulates an ask turn from stream parts: text deltas, finished steps,
 * validate_build snapshots (by label) and successful present_build calls.
 */
export function createAskTurnCollector() {
  let content = "";
  let steps = 0;
  const snapshots = new Map<string, BuildSnapshot>();
  const presented: PresentedBuild[] = [];
  let streamError: string | undefined;

  function observe(part: AskStreamPart): void {
    if (part.type === "text-delta") {
      content += String((part as { text?: unknown }).text ?? "");
    } else if (part.type === "finish-step") {
      steps += 1;
    } else if (part.type === "error") {
      const err = (part as { error?: unknown }).error;
      streamError = err instanceof Error ? err.message : String(err);
    } else if (part.type === "tool-result") {
      const { toolName } = part as { toolName: string };
      const out = unwrap((part as { output?: unknown }).output);
      if (!out || typeof out !== "object") return;
      if (toolName === "validate_build") {
        const obj = out as { builds?: Record<string, { snapshot?: BuildSnapshot }>; snapshot?: BuildSnapshot };
        const entries = obj.builds && typeof obj.builds === "object" ? Object.entries(obj.builds) : [["", obj] as const];
        for (const [key, entry] of entries) {
          const snap = entry?.snapshot;
          const label = key || snap?.label;
          if (snap && label) snapshots.set(normalizeLabel(label), snap);
        }
      } else if (toolName === "present_build") {
        const obj = out as { presented?: unknown; builds?: unknown };
        if (obj.presented === false || !Array.isArray(obj.builds)) return;
        for (const raw of obj.builds as Array<{ label?: unknown; product_ids?: unknown; notes?: unknown }>) {
          if (typeof raw?.label !== "string") continue;
          presented.push({
            label: raw.label,
            ...(Array.isArray(raw.product_ids) ? { product_ids: raw.product_ids as string[] } : {}),
            ...(typeof raw.notes === "string" ? { notes: raw.notes } : {}),
            ...(snapshots.has(normalizeLabel(raw.label)) ? { snapshot: snapshots.get(normalizeLabel(raw.label)) } : {})
          });
        }
      }
    }
  }

  return {
    observe,
    result: (): AskTurn => ({ content, steps, builds: presented, ...(streamError ? { streamError } : {}) })
  };
}

/**
 * Why an ask turn failed, or undefined when it produced something: text or
 * at least one presented build. An empty turn is an error so scripts don't
 * read `{"content":""}` as success.
 */
export function askTurnError(turn: AskTurn): string | undefined {
  if (turn.content.trim().length > 0 || turn.builds.length > 0) return undefined;
  if (turn.streamError) return `The turn failed after ${turn.steps} step${turn.steps === 1 ? "" : "s"}: ${turn.streamError}`;
  return `The model ended the turn without an answer after ${turn.steps} step${turn.steps === 1 ? "" : "s"}.`;
}

/** One line per presented build for terminal output. */
export function formatPresentedBuilds(builds: PresentedBuild[]): string {
  return builds
    .map((build) => {
      const snap = build.snapshot;
      if (!snap) return `Build: ${build.label}`;
      const total = snap.total != null ? ` — total ${snap.currency} ${snap.total}` : "";
      const parts = snap.components.map((c) => `  ${c.category}: ${c.name}${c.price != null ? ` (${c.currency} ${c.price})` : ""}`);
      return [`Build: ${build.label}${total}`, ...parts].join("\n");
    })
    .join("\n");
}
