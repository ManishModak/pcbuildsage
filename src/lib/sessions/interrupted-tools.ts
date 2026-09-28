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

/**
 * Rewrite stuck tool calls in a **finished** turn into a visible
 * `output-error` / "Interrupted" state. Applied in memory on read only: the
 * stored transcript is never rewritten, and a live stream is never touched.
 *
 * Every caller is a fresh read of a stored session, where nothing is streaming by
 * definition, so a stuck part is always a leftover. The live-stream case does not
 * reach here: a streaming transcript is in memory, not in storage.
 *
 * `streamingMessageId` is the one exception: a transcript saved mid-stream
 * (the throttled mid-stream save, or a page-close flush) can be re-read while
 * the same turn is still streaming - e.g. a sidebar refresh that re-renders
 * from storage. That turn's in-flight parts are not abandoned, so they are
 * left alone; only finished or abandoned turns are marked.
 */
export function markInterruptedToolCalls(
  messages: readonly unknown[],
  options: { streamingMessageId?: string } = {}
): unknown[] {
  const { streamingMessageId } = options;
  let changed = false;

  const cleaned = messages.map((message) => {
    if (typeof message !== "object" || message === null) return message;
    if (
      streamingMessageId !== undefined &&
      (message as { id?: unknown }).id === streamingMessageId
    ) {
      return message;
    }
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
