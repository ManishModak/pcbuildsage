import { type UIMessage } from "ai";
import { toCompactSearchResult } from "@/lib/catalog/compact";

/** The message-part union the AI SDK accepts on a UIMessage. */
export type ChatMessagePart = UIMessage["parts"][number];

export type ChatMessage = {
  id?: string;
  role: "user" | "assistant" | "system";
  content?: string;
  parts?: ChatMessagePart[];
};

/**
 * A message as it arrives over HTTP: the route's zod schema only guarantees a
 * `type` string per part, so parts stay loosely typed until compaction hands
 * them to the SDK.
 */
export type IncomingChatMessage = {
  role: string;
  content?: string;
  parts?: Array<{ type: string } & Record<string, unknown>>;
};

/** A finished validate_build call distilled into what a resume needs. */
type FinishedValidation = { parts: unknown; verdict?: unknown; snapshot?: unknown };

/** A finished validate_build call plus its raw output, for per-label lookup. */
type ValidationAt = { order: number; validation: FinishedValidation; output: unknown };

/**
 * A tool call the model never finished: still streaming, waiting to run, or
 * errored. It must never be resumed from - its input is a half-written record
 * of what the model meant to build, and treating it as authoritative is what
 * pinned a session to a build that was never validated.
 */
function isUnfinishedState(state: unknown): boolean {
  return state === "input-streaming" || state === "input-available" || state === "output-error";
}

/** Pull `input.parts` (or the first `input.builds[].parts`) out of a call. */
function partsOfInput(input: unknown): unknown {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as { parts?: unknown; builds?: unknown };
  if (obj.parts !== undefined) return obj.parts;
  if (Array.isArray(obj.builds)) {
    return (obj.builds[0] as { parts?: unknown } | undefined)?.parts;
  }
  return undefined;
}

/**
 * The verdict and snapshot a finished validate_build output produced, for the
 * build named `label` when given (a batch validates several builds and the
 * presented one need not be first), else the first build.
 */
function verdictAndSnapshot(output: unknown, label?: string): { verdict: unknown; snapshot: unknown } {
  if (!output || typeof output !== "object") return { verdict: undefined, snapshot: undefined };
  const outObj = output as Record<string, unknown>;
  if (outObj.builds && typeof outObj.builds === "object") {
    const entries = Object.entries(outObj.builds as Record<string, unknown>);
    const wanted = label?.trim().toLowerCase();
    const match = wanted ? entries.find(([key]) => key.trim().toLowerCase() === wanted) : undefined;
    const build = (match ?? entries[0])?.[1] as Record<string, unknown> | undefined;
    return { verdict: compactVerdict(build), snapshot: build?.snapshot };
  }
  return { verdict: compactVerdict(output), snapshot: outObj.snapshot };
}

/** Whether a validate_build output has a build named `label`. */
function hasBuildLabel(output: unknown, label?: string): boolean {
  const wanted = label?.trim().toLowerCase();
  if (!wanted || !output || typeof output !== "object") return false;
  const builds = (output as { builds?: unknown }).builds;
  if (!builds || typeof builds !== "object") return false;
  return Object.keys(builds).some((key) => key.trim().toLowerCase() === wanted);
}

/**
 * The first build a finished present_build showed: its label and parts. The
 * input's parts/product_ids win; a label-only call (the tool defaults to the
 * validated snapshot) takes the full IDs from the tool's output instead.
 * Returns null for a call the tool rejected (`presented: false`) - the user
 * was shown nothing, so it is not the build to resume from.
 */
function presentedBuildOf(part: unknown): { label?: string; parts: unknown } | null {
  const output = (part as { output?: unknown }).output;
  if (output && typeof output === "object" && (output as { presented?: unknown }).presented === false) return null;
  const input = (part as { input?: unknown }).input;
  const builds = input && typeof input === "object" ? (input as { builds?: unknown }).builds : undefined;
  if (!Array.isArray(builds) || builds.length === 0) return null;
  const first = builds[0] as { label?: unknown; parts?: unknown; product_ids?: unknown } | undefined;
  const label = typeof first?.label === "string" ? first.label : undefined;
  let parts = first?.parts ?? first?.product_ids;
  if (parts === undefined && output && typeof output === "object") {
    const outBuilds = (output as { builds?: unknown }).builds;
    if (Array.isArray(outBuilds)) {
      const wanted = label?.trim().toLowerCase();
      const match =
        (outBuilds as Array<{ label?: unknown; product_ids?: unknown }>).find(
          (b) => typeof b?.label === "string" && b.label.trim().toLowerCase() === wanted
        ) ?? (outBuilds[0] as { product_ids?: unknown } | undefined);
      parts = match?.product_ids;
    }
  }
  if (parts === undefined) return null;
  return { ...(label !== undefined ? { label } : {}), parts };
}

/** An output that looks like a completed validation rather than a stub. */
function looksCompleted(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const out = output as Record<string, unknown>;
  if (out.builds && typeof out.builds === "object") {
    return Object.values(out.builds).some(
      (build) => Boolean(build) && typeof build === "object" && "valid" in (build as object)
    );
  }
  return "valid" in out;
}

/**
 * The build to resume from, as the assistant last saw it.
 *
 * Prefers what was actually presented, and otherwise the latest validation that
 * finished: an interrupted `validate_build` used to win simply by being last,
 * so "continue" resumed a build that was never validated. The return shape is
 * unchanged - `parts` plus the optional `verdict` and `snapshot` - with
 * `source` added so a caller can tell a presentation from a validation.
 *
 * Pairing rule: a presentation is paired with the validation from its own
 * turn (the latest finished validation at or before the presentation), never
 * with a later one. A validation that finished *after* the presentation
 * describes a build the user was never shown; merging its verdict/snapshot
 * into the presented build would resume from parts the verdict never checked.
 * That newer, unpresented validation is returned separately as
 * `unpresentedValidation` instead.
 */
export function deriveBuildState(uiMessages: UIMessage[]): {
  parts: unknown;
  verdict?: unknown;
  snapshot?: unknown;
  source?: "present_build" | "validate_build";
  /**
   * A finished validation newer than the presented build, describing a build
   * the user was never shown. Deliberately separate from `verdict`/`snapshot`
   * so no caller can mistake it for the presented build's own validation.
   */
  unpresentedValidation?: { parts: unknown; verdict?: unknown; snapshot?: unknown };
} | null {
  let presented: { parts: unknown; label?: string; order: number } | null = null;
  const validations: ValidationAt[] = [];
  let order = 0;

  for (const message of uiMessages) {
    if (!message.parts) continue;
    for (const part of message.parts) {
      const name = toolNameOf(part);
      if (!name) continue;
      if (isUnfinishedState((part as { state?: unknown }).state)) continue;

      if (name.includes("present_build")) {
        const shown = presentedBuildOf(part);
        if (!shown) continue;
        presented = { ...shown, order: order++ };
        continue;
      }

      if (!name.includes("validate_build")) continue;
      if (!looksCompleted((part as { output?: unknown }).output)) continue;
      const parts = partsOfInput((part as { input?: unknown }).input);
      if (parts === undefined) continue;
      const { verdict, snapshot } = verdictAndSnapshot((part as { output?: unknown }).output);
      validations.push({
        order: order++,
        output: (part as { output?: unknown }).output,
        validation: {
          parts,
          ...(verdict !== undefined ? { verdict } : {}),
          ...(snapshot !== undefined ? { snapshot } : {})
        }
      });
    }
  }

  const latestValidation = validations.length > 0 ? validations[validations.length - 1].validation : null;

  // Merge, do not replace. A presentation says which build the user was last
  // shown; a validation is where the verdict and the catalog snapshot live, and
  // compaction seeds itself from that snapshot. Preferring the presentation must
  // not drop them, or the commonest session shape - validated, then presented -
  // would hand compaction nothing to work from. But the validation merged in is
  // the presentation's own (same turn or earlier): a later validation belongs
  // to a build that was never presented.
  if (presented) {
    const earlier = [...validations].reverse().filter((v) => v.order <= presented!.order);
    const ownAt = earlier.find((v) => hasBuildLabel(v.output, presented!.label)) ?? earlier[0] ?? null;
    const newer = [...validations].reverse().find((v) => v.order > presented!.order)?.validation ?? null;
    // The presented build's own verdict/snapshot, picked by its label so a
    // batch that validated A and B and presented B resumes from B.
    const own = ownAt ? verdictAndSnapshot(ownAt.output, presented.label) : null;
    return {
      parts: presented.parts,
      ...(own && own.verdict !== undefined ? { verdict: own.verdict } : {}),
      ...(own && own.snapshot !== undefined ? { snapshot: own.snapshot } : {}),
      source: "present_build",
      ...(newer ? { unpresentedValidation: { ...newer } } : {})
    };
  }
  if (!latestValidation) return null;
  return {
    parts: latestValidation.parts,
    ...("verdict" in latestValidation ? { verdict: latestValidation.verdict } : {}),
    ...("snapshot" in latestValidation ? { snapshot: latestValidation.snapshot } : {}),
    source: "validate_build"
  };
}

/**
 * Compact chat messages for LLM context.
 * - Non-text parts are stripped to keep memory usage low (compact memory).
 * - Exception: tool parts (calls and results) are kept for the last assistant turn only,
 *   so immediately-preceding search results are still exact if the user references them.
 * - For search_products tool parts, compacts product fields across ALL historical candidates
 *   (preserving all returned parts while eliminating duplicate arrays and verbose metadata).
 */
export function compactChatMessages(messages: IncomingChatMessage[]): ChatMessage[] {
  const lastAssistantIdx = messages.reduce(
    (last, msg, idx) => (msg.role === "assistant" ? idx : last),
    -1
  );

  return messages.map((message, idx) => {
    const isLastAssistant = idx === lastAssistantIdx;
    if (isLastAssistant && message.parts) {
      // Keep tool parts for the last assistant turn only, compacting search outputs across all candidates
      const compactedParts = message.parts.map((part) => {
        const name = toolNameOf(part);
        if (name === "search_products") {
          const rawOutput = (part as { output?: unknown }).output;
          if (rawOutput && typeof rawOutput === "object") {
            return {
              ...part,
              output: toCompactSearchResult(rawOutput as Record<string, unknown>)
            };
          }
        }
        return part;
      });

      return {
        role: message.role as "user" | "assistant" | "system",
        content: message.content,
        parts: compactedParts as ChatMessagePart[]
      };
    }
    // Compact memory: strip non-text parts and merge text parts into content
    const textContent =
      message.content ??
      message.parts
        ?.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
        .join("\n") ??
      "";
    return {
      role: message.role as "user" | "assistant" | "system",
      content: textContent,
      parts: [{ type: "text", text: textContent }]
    };
  });
}

export const MAX_RESUME_MESSAGES = 40;

/**
 * Long-session guardrail: caps the replayed history at MAX_RESUME_MESSAGES.
 * Always keeps the first user message (which states the goal/budget).
 */
export function capMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= MAX_RESUME_MESSAGES) {
    return messages;
  }
  const firstUser = messages.find((m) => m.role === "user");
  const recentCount = MAX_RESUME_MESSAGES - 1;
  const recent = messages.slice(-recentCount);
  const includesFirstUser = firstUser && recent.some((m) => m === firstUser);
  if (includesFirstUser) {
    return messages.slice(-MAX_RESUME_MESSAGES);
  }
  if (firstUser) {
    return [firstUser, ...recent];
  }
  return messages.slice(-MAX_RESUME_MESSAGES);
}

function compactVerdict(output: unknown): unknown | undefined {
  if (!output || typeof output !== "object") return undefined;
  const value = output as Record<string, unknown>;
  const issues = Array.isArray(value.issues) ? (value.issues as Array<{ severity?: string }>) : [];
  const blocking = issues.filter((issue) => issue?.severity === "blocking").length;
  return { valid: Boolean(value.valid), blocking, issues: issues.length };
}

function toolNameOf(part: unknown): string | null {
  if (!part || typeof part !== "object") return null;
  const type = (part as { type?: unknown }).type;
  if (typeof type !== "string") return null;
  if (type === "dynamic-tool") {
    const toolName = (part as { toolName?: unknown }).toolName;
    return typeof toolName === "string" ? toolName : null;
  }
  return type.startsWith("tool-") ? type.slice("tool-".length) : null;
}
