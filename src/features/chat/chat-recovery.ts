import type { UIMessage } from "ai";

/** Check whether an error is specifically caused by context window / token limit overflow. */
export function isContextLimitError(error: unknown): boolean {
  if (!error) return false;
  const value = error as { name?: string; message?: string; status?: number; statusCode?: number } | null;
  const message = (value?.message ?? String(error)).toLowerCase();
  return (
    message.includes("context_length_exceeded") ||
    message.includes("maximum context length") ||
    message.includes("context window") ||
    message.includes("context limit") ||
    message.includes("string_above_max_length") ||
    message.includes("prompt is too long") ||
    message.includes("too many tokens") ||
    message.includes("max_tokens") ||
    (message.includes("token limit") && message.includes("exceeded")) ||
    (message.includes("tokens") && message.includes("limit") && message.includes("exceed"))
  );
}

/** Only transient transport/provider failures qualify for unchanged replay; cancellation, auth, and context overflow do not. */
export function isRecoverableChatError(error: unknown): boolean {
  if (isContextLimitError(error)) return false;
  const value = error as { name?: string; message?: string; status?: number; statusCode?: number } | null;
  const message = value?.message ?? String(error);
  if (value?.name === "AbortError" || /abort|cancel|unauthorized|forbidden|invalid.*(?:key|credential)|\b40[13]\b/i.test(message)) return false;
  const status = value?.statusCode ?? value?.status;
  if (status === 401 || status === 403) return false;
  return status === 429 || (status !== undefined && status >= 500 && status < 600) ||
    /\b(?:429|5\d\d)\b|upstream|provider.*error|network|fetch failed|failed to fetch|connection|econnreset|timeout|timed out|rate limit|temporarily unavailable/i.test(message);
}

/** Retain completed work, but never replay a tool call whose input/result was interrupted. */
export function prepareChatRecovery<T extends UIMessage>(messages: T[]): T[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.filter((part) => {
      if (part.type !== "dynamic-tool" && !part.type.startsWith("tool-")) return true;
      const state = (part as { state?: string }).state;
      return state === "output-available" || state === "output-error" || state === "output-denied";
    })
  }));
}

/** Detect a completed provider turn with no user-facing answer, excluding stop/error events. */
export function isIncompleteChatFinish(message: UIMessage, flags: { isAbort: boolean; isError: boolean }): boolean {
  if (flags.isAbort || flags.isError || message.role !== "assistant") return false;
  return !message.parts.some((part) => {
    if (part.type === "text") return Boolean(part.text.trim());
    const tool = part as { type: string; toolName?: string; state?: string; output?: unknown };
    if (tool.type !== "tool-present_build" && !(tool.type === "dynamic-tool" && tool.toolName === "present_build")) return false;
    const output = tool.output as { presented?: boolean; builds?: unknown[] } | undefined;
    return tool.state === "output-available" && output?.presented === true && Boolean(output.builds?.length);
  });
}

/** One delayed recovery per user request; reset only for a new user action. */
export class ChatRecovery {
  private used = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private abortController: AbortController | null = null;

  canRecover(): boolean {
    return !this.used;
  }

  schedule(error: unknown, recover: () => void): boolean {
    if (!isRecoverableChatError(error)) return false;
    return this.scheduleIncomplete(recover);
  }

  // Silent early endings and explicit errors share the same retry budget.
  scheduleIncomplete(recover: () => void): boolean {
    if (this.used) return false;
    this.used = true;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      recover();
    }, 750);
    return true;
  }

  /**
   * Compact-before-retry recovery: allows exactly one attempt for a context-limit error.
   * Respects cancellation and bounds recovery.
   */
  scheduleContextRecovery(
    error: unknown,
    compactAndRecover: (signal: AbortSignal) => Promise<void> | void
  ): boolean {
    if (!isContextLimitError(error)) return false;
    if (this.used) return false;
    this.used = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    try {
      Promise.resolve(compactAndRecover(signal)).catch((err) => {
        if (!signal.aborted) {
          console.error("Context recovery execution failed:", err);
        }
      });
    } catch (err) {
      console.error("Context recovery synchronous launch failed:", err);
    }
    return true;
  }

  cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.used = true;
  }

  reset(): void {
    this.cancel();
    this.used = false;
  }
}
