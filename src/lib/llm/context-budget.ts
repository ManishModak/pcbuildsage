/**
 * Context window tracking, token estimation, and compaction threshold detection.
 * Avoids fragile model-regex guessing: prioritizes provider metadata, runtime
 * error disclosures, user config, and falls back to an explicit conservative budget.
 */

export const DEFAULT_FALLBACK_CONTEXT_LIMIT = 32_768;
export const COMPACTION_TRIGGER_RATIO = 0.78; // Trigger compaction around 78–80%
export const COMPACTION_MAX_RATIO = 0.80;
export const RESERVED_OUTPUT_TOKENS = 4_096;
export const TOOL_DEFINITIONS_TOKEN_OVERHEAD = 1_200;

/**
 * Conservative estimate of token count from text, objects, or message arrays.
 * Uses ~3.5 characters per token plus structure overhead.
 */
export function estimateTokens(content: unknown): number {
  if (content === null || content === undefined) return 0;
  if (typeof content === "string") {
    return Math.ceil(content.length / 3.5);
  }
  if (Array.isArray(content)) {
    return content.reduce<number>((sum, item) => sum + estimateTokens(item) + 4, 0);
  }
  if (typeof content === "object") {
    try {
      const json = JSON.stringify(content);
      return Math.ceil(json.length / 3.5);
    } catch {
      return 100;
    }
  }
  return 10;
}

/**
 * Parses exact model context limit disclosed in provider error messages.
 * e.g., "This model's maximum context length is 262144 tokens"
 */
export function parseContextLimitFromError(error: unknown): number | undefined {
  if (!error) return undefined;
  const msg = (error as { message?: string })?.message ?? String(error);
  const match =
    msg.match(/(?:maximum context length is|context window of|context length is|limit is)\s+([0-9,]+)/i) ??
    msg.match(/(?:context_length|max_context_length|context_window)["':\s]+([0-9,]+)/i) ??
    msg.match(/([0-9,]+)\s*(?:max\s*)?tokens?\s*(?:limit|maximum|context)/i);

  if (match && match[1]) {
    const rawNumber = match[1].replace(/,/g, "");
    const parsed = parseInt(rawNumber, 10);
    if (Number.isFinite(parsed) && parsed >= 2048) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * Resolve the active model's context limit using configuration, provider metadata,
 * or the explicit conservative budget (32,768 tokens).
 */
export function getModelContextLimit(
  entryOrModelId?: string | { model?: string; provider?: string; contextLimit?: number },
  provider?: string,
  configuredLimit?: number
): number {
  if (typeof entryOrModelId === "object" && entryOrModelId !== null) {
    if (typeof entryOrModelId.contextLimit === "number" && entryOrModelId.contextLimit > 0) {
      return entryOrModelId.contextLimit;
    }
    return DEFAULT_FALLBACK_CONTEXT_LIMIT;
  }
  if (typeof configuredLimit === "number" && configuredLimit > 0) {
    return configuredLimit;
  }
  return DEFAULT_FALLBACK_CONTEXT_LIMIT;
}

/**
 * Check if current context usage warrants compaction (around 78–80% or approaching reserve boundary).
 */
export function shouldTriggerCompaction(currentTokens: number, contextLimit: number): boolean {
  if (!contextLimit || contextLimit <= 0) return false;
  const ratio = currentTokens / contextLimit;
  const reserveThreshold = contextLimit - RESERVED_OUTPUT_TOKENS;
  return ratio >= COMPACTION_TRIGGER_RATIO || currentTokens >= reserveThreshold;
}
