/**
 * src/lib/analytics/events.ts
 *
 * Anonymous analytics event allow-lists, schema DDL, and sanitizers.
 *
 * Privacy contract: daily aggregate counts only. There are deliberately NO
 * ip, message, user-id, session-id, user-agent, or URL columns anywhere.
 * Server counts chat_started / build_presented / provider_used / error_type;
 * browsers may only report landing_view / onboarding_completed via /api/metrics.
 */

import type { LLMProvider } from "@/types/config";

export const SERVER_ANALYTICS_EVENTS = [
  "chat_started",
  "build_presented",
  "provider_used",
  "error_type"
] as const;

export const CLIENT_ANALYTICS_EVENTS = ["landing_view", "onboarding_completed"] as const;

export const ANALYTICS_EVENTS = [...SERVER_ANALYTICS_EVENTS, ...CLIENT_ANALYTICS_EVENTS] as const;

export type ServerAnalyticsEvent = (typeof SERVER_ANALYTICS_EVENTS)[number];
export type ClientAnalyticsEvent = (typeof CLIENT_ANALYTICS_EVENTS)[number];
export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

export function isAnalyticsEvent(value: unknown): value is AnalyticsEvent {
  return (
    typeof value === "string" && (ANALYTICS_EVENTS as readonly string[]).includes(value)
  );
}

/** Single-table schema: day-granularity counters, nothing attributable. */
export const DAILY_COUNTS_DDL =
  "CREATE TABLE IF NOT EXISTS daily_counts (" +
  "day TEXT NOT NULL, " +
  "event TEXT NOT NULL, " +
  "dimension TEXT NOT NULL DEFAULT '', " +
  "count INTEGER NOT NULL DEFAULT 0, " +
  "PRIMARY KEY (day, event, dimension))";

export const ANALYTICS_UPSERT_SQL =
  "INSERT INTO daily_counts (day, event, dimension, count) VALUES (?, ?, ?, ?) " +
  "ON CONFLICT (day, event, dimension) DO UPDATE SET count = count + excluded.count";

const MAX_DIMENSION_LENGTH = 128;

/** Dimensions carry coarse labels only (provider id, error class); strip anything else. */
export function sanitizeDimension(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:._-]/g, "")
    .slice(0, MAX_DIMENSION_LENGTH);
}

/**
 * provider_used dimensions: a fixed allow-list of provider ids, nothing else.
 * The model id is client-sent free text (a pasted key or name could land in
 * it) and has unbounded distinct values, so it is never recorded.
 */
export const ANALYTICS_PROVIDERS = [
  "gemini",
  "groq",
  "openrouter",
  "ollama",
  "openai-compatible"
] as const satisfies readonly LLMProvider[];

/** Maps a provider to its allow-listed id, or "other". */
export function providerDimension(provider: unknown): string {
  return (ANALYTICS_PROVIDERS as readonly unknown[]).includes(provider) ? String(provider) : "other";
}

function statusFromUnknown(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null) {
    const obj = error as {
      statusCode?: unknown;
      status?: unknown;
      response?: { status?: unknown };
      cause?: unknown;
    };
    const direct = obj.statusCode ?? obj.status ?? obj.response?.status;
    if (typeof direct === "number") return direct;
    if (typeof obj.cause === "object" && obj.cause !== null) {
      const inner = obj.cause as { statusCode?: unknown; status?: unknown };
      const nested = inner.statusCode ?? inner.status;
      if (typeof nested === "number") return nested;
    }
  }
  return undefined;
}

/**
 * Maps any thrown value to a coarse error class. Never includes raw
 * messages, keys, URLs, or provider text — only the class label.
 */
export function classifyErrorType(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "ZodError" || name === "UnsafeConfigError") return "bad_request";
  const status = statusFromUnknown(error);
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status !== undefined && status >= 500) return "upstream";
  const text = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  if (/unauthorized|forbidden|invalid api key|invalid_api_key|api key/.test(text)) return "auth";
  if (/rate limit|too many requests|quota|429/.test(text)) return "rate_limit";
  if (/request body|payload_too_large|validation|invalid request|bad request|400/.test(text)) {
    return "bad_request";
  }
  if (/timeout|timed out|network|fetch failed|upstream|econn|enotfound|502|503|504/.test(text)) {
    return "upstream";
  }
  return "unknown";
}
