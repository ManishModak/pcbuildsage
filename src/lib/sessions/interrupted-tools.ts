import { isToolPart } from "@/lib/message-parts";

/**
 * A tool call is "stuck" when it was persisted before the assistant turn that
 * produced it could finish — the browser (or the tab) went away mid-stream and
 * the part kept its in-flight state. The AI SDK uses these states to mean "a
 * result is still on its way", so rendering one forever shows a permanent
 * spinner and a tool that never resolves.
 */
const STUCK_TOOL_STATES = new Set(["input-streaming", "input-available"]);

/** The `errorText` shown for a tool call that never got to run to completion. */
export const INTERRUPTED_ERROR_TEXT = "Interrupted";

export function isStuckToolState(state: unknown): boolean {
  return typeof state === "string" && STUCK_TOOL_STATES.has(state);
}

export type InterruptedCleanupOptions = {
  /**
   * True when the transcript being cleaned is attached to a *live* stream. On a
   * fresh load nothing is streaming, so every stuck part is a leftover.
   */
  isStreaming?: boolean;
};

/**
 * Rewrite stuck tool calls in a **finished** turn into a visible
 * `output-error` / "Interrupted" state. Applied in memory on read only: the
 * stored transcript is never rewritten, and a live stream is never touched.
 *
 * A turn counts as finished when it is not the last message, or when the
 * transcript as a whole is not currently streaming.
 */
export function markInterruptedToolCalls(
  messages: readonly unknown[],
  options: InterruptedCleanupOptions = {}
): unknown[] {
  const lastIndex = messages.length - 1;
  let changed = false;

  const cleaned = messages.map((message, index) => {
    if (options.isStreaming && index === lastIndex) return message;
    if (typeof message !== "object" || message === null) return message;
    const parts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) return message;

    let partsChanged = false;
    const nextParts = parts.map((part) => {
      if (!isToolPart(part) || !isStuckToolState(part.state)) return part;
      partsChanged = true;
      // Drop a half-parsed input/output so nothing renders a spinner or an
      // empty result; the interrupted part carries only the error.
      const { input: _input, output: _output, ...rest } = part;
      void _input;
      void _output;
      return { ...rest, state: "output-error", errorText: INTERRUPTED_ERROR_TEXT };
    });

    if (!partsChanged) return message;
    changed = true;
    return { ...(message as object), parts: nextParts };
  });

  return changed ? cleaned : (messages as unknown[]);
}
