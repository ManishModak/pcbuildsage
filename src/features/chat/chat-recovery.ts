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
  // One definition of "rate limited", shared with the delay picker: a spelling
  // that classifies as a rate limit must also be retried, or the wait never runs.
  if (isRateLimitError(error)) return true;
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

/** A 5xx or a dropped stream is usually healthy again almost immediately. */
const TRANSIENT_RECOVERY_DELAY_MS = 750;
/**
 * Provider rate limits are counted per minute (Groq's and Gemini's free tiers
 * both report a token window that resets inside a minute), so a retry inside
 * the same window always fails and only spends the request budget. Ten seconds
 * is about a window reset; waiting longer would look like a frozen app.
 */
export const RATE_LIMIT_RECOVERY_DELAY_MS = 10_000;

/**
 * True when the failure is a provider quota/rate limit rather than a transient
 * fault. The server prefixes its plain-language copy but keeps `[HTTP 429]` and
 * the provider's wording, so matching the text works on what the UI receives.
 */
export function isRateLimitError(error: unknown): boolean {
  const value = error as { status?: number; statusCode?: number; message?: string } | null;
  const status = value?.statusCode ?? value?.status;
  if (status === 429) return true;
  const message = value?.message ?? String(error);
  return /\b429\b|rate.?limit|too many requests|token.{0,10}(per minute|window)|quota/i.test(message);
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
    return this.scheduleOnce(recover, isRateLimitError(error) ? RATE_LIMIT_RECOVERY_DELAY_MS : TRANSIENT_RECOVERY_DELAY_MS);
  }

  // Silent early endings and explicit errors share the same retry budget.
  scheduleIncomplete(recover: () => void): boolean {
    return this.scheduleOnce(recover, TRANSIENT_RECOVERY_DELAY_MS);
  }

  private scheduleOnce(recover: () => void, delayMs: number): boolean {
    if (this.used) return false;
    this.used = true;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      recover();
    }, delayMs);
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
