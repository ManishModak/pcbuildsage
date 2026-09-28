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

/** The verdict and snapshot a finished validate_build output produced. */
function verdictAndSnapshot(output: unknown): { verdict: unknown; snapshot: unknown } {
  if (!output || typeof output !== "object") return { verdict: undefined, snapshot: undefined };
  const outObj = output as Record<string, unknown>;
  if (outObj.builds && typeof outObj.builds === "object") {
    const firstBuild = Object.values(outObj.builds)[0] as Record<string, unknown> | undefined;
    return { verdict: compactVerdict(firstBuild), snapshot: firstBuild?.snapshot };
  }
  return { verdict: compactVerdict(output), snapshot: outObj.snapshot };
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
  type ValidationAt = { order: number; validation: FinishedValidation };
  let presented: (FinishedValidation & { order: number }) | null = null;
  const validations: ValidationAt[] = [];
  let order = 0;

  for (const message of uiMessages) {
    if (!message.parts) continue;
    for (const part of message.parts) {
      const name = toolNameOf(part);
      if (!name) continue;
      if (isUnfinishedState((part as { state?: unknown }).state)) continue;

      if (name.includes("present_build")) {
        const input = (part as { input?: unknown }).input;
        const builds = input && typeof input === "object" ? (input as { builds?: unknown }).builds : undefined;
        if (!Array.isArray(builds) || builds.length === 0) continue;
        const first = builds[0] as { parts?: unknown; product_ids?: unknown } | undefined;
        const parts = first?.parts ?? first?.product_ids;
        if (parts === undefined) continue;
        presented = { parts, order: order++ };
        continue;
      }

      if (!name.includes("validate_build")) continue;
      if (!looksCompleted((part as { output?: unknown }).output)) continue;
      const parts = partsOfInput((part as { input?: unknown }).input);
      if (parts === undefined) continue;
      const { verdict, snapshot } = verdictAndSnapshot((part as { output?: unknown }).output);
      validations.push({
        order: order++,
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
    const own = [...validations].reverse().find((v) => v.order <= presented!.order)?.validation ?? null;
    const newer = [...validations].reverse().find((v) => v.order > presented!.order)?.validation ?? null;
    return {
      parts: presented.parts,
      ...(own && "verdict" in own ? { verdict: own.verdict } : {}),
      ...(own && "snapshot" in own ? { snapshot: own.snapshot } : {}),
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
