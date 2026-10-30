import type { PingResult } from "@/types/client";
import {
  ACCESS_BLOCKED_COPY,
  DEMO_RATE_LIMIT_COPY,
  FREE_LIMIT_COPY,
  KEY_REJECTED_COPY,
  mapProviderErrorToPlainLanguage
} from "@/content/api-key-help";

export type ProbeOutcomeKind = "ok" | "key" | "quota" | "tools" | "network" | "unknown";

export type ProbeOutcome = { kind: ProbeOutcomeKind; message: string };

/**
 * /api/llm/probe also sends `toolProbeReason` ("no_tool_call" | "request_failed")
 * when the model answered but the tool test failed. PingResult does not
 * declare it, so read it defensively.
 */
type ProbeResponse = PingResult & { toolProbeReason?: unknown };

const MESSAGES = {
  ok: "Works, and can use tools.",
  key: "Key rejected. Check you copied the whole key, or make a new one.",
  keyMissing: "No key found for this provider. Paste your key, then check again.",
  keyBlocked: "Your key can't use this model. Pick another model or provider.",
  quota: "Rate limit or quota reached. Wait a minute or try another model.",
  tools: "This model can't use tools. Pick one marked Recommended.",
  network: "Couldn't reach the provider. Check your connection and try again.",
  timeout: "The model took too long to answer. Try again, or pick a faster model.",
  noAnswer: "The model didn't answer. Check the model name, wait a minute, then try again.",
  unknown: "The check failed. See the details below."
} as const;

// The plain reply text probeToolCapability returns for "no_tool_call" (src/lib/llm/client.ts).
const NO_TOOL_CALL_PATTERN = /instead of calling the test tool/i;

// Same needles as isToolsUnsupportedError in src/lib/llm/client.ts. That
// module is server-only (it imports node:dns via web-search), so they are
// repeated here for the browser.
const TOOLS_UNSUPPORTED_PATTERN =
  /function calling|function_call|tool_choice|tool-call|tool call|does not support tools|tools not supported|unsupported tool|no tool support|tool use|tool_use/i;

// No key reached the provider: the AI SDK's loadApiKey ("Google Generative AI
// API key is missing. …") and OpenRouter's 401 ("No cookie auth credentials found").
const KEY_MISSING_PATTERN = /api key is missing|no (cookie )?auth credentials found/i;

// Provider replies to a bad key that the shared AUTH_FAILURE_PATTERN misses:
// Gemini "API key not valid. Please pass a valid API key." (also matched in
// src/lib/tools/consult.ts) and OpenRouter "User not found.".
const BAD_KEY_PATTERN = /api key not valid|api_key_invalid|^user not found\.?$/i;

// probeToolCapability's timeout copy, plus raw abort/timeout errors.
const TIMEOUT_PATTERN = /didn't finish in time|timeout|timed out|aborted/i;

// AI SDK wraps fetch failures as "Cannot connect to API: …"; the browser
// reports "Failed to fetch" when our own server can't be reached.
const NETWORK_PATTERN = /cannot connect to api|fetch failed|failed to fetch|networkerror|network error|econnrefused|enotfound|econnreset|ehostunreach|socket hang up/i;

// generateTextWithFallback hides the cause of a fallbackable error (404, 429,
// 5xx, timeout, network) behind this AggregateError message.
const ALL_FAILED_PATTERN = /all fallback llm providers failed/i;

/**
 * Turns a model check (/api/llm/probe) into one plain failure kind and a short,
 * actionable message. Used by the settings chain builder and the onboarding
 * wizard; show `result.hint` beside the message as the raw detail.
 */
export function describeProbeResult(result: PingResult): ProbeOutcome {
  if (result.reachable && result.toolCapable) return { kind: "ok", message: MESSAGES.ok };

  const hint = (result.hint ?? "").trim();
  const reason = (result as ProbeResponse).toolProbeReason;

  // The probe route leads failed tool tests with shared plain copy.
  if (hint.startsWith(KEY_REJECTED_COPY)) return { kind: "key", message: MESSAGES.key };
  if (hint.startsWith(ACCESS_BLOCKED_COPY)) return { kind: "key", message: MESSAGES.keyBlocked };
  if (hint.startsWith(FREE_LIMIT_COPY) || hint.startsWith(DEMO_RATE_LIMIT_COPY)) {
    return { kind: "quota", message: MESSAGES.quota };
  }

  if (reason === "no_tool_call" || NO_TOOL_CALL_PATTERN.test(hint)) {
    return { kind: "tools", message: MESSAGES.tools };
  }

  if (KEY_MISSING_PATTERN.test(hint)) return { kind: "key", message: MESSAGES.keyMissing };
  if (BAD_KEY_PATTERN.test(hint)) return { kind: "key", message: MESSAGES.key };

  const plain = mapProviderErrorToPlainLanguage({ message: hint });
  if (plain === KEY_REJECTED_COPY) return { kind: "key", message: MESSAGES.key };
  if (plain === ACCESS_BLOCKED_COPY) return { kind: "key", message: MESSAGES.keyBlocked };
  if (plain === FREE_LIMIT_COPY || plain === DEMO_RATE_LIMIT_COPY) return { kind: "quota", message: MESSAGES.quota };

  if (TOOLS_UNSUPPORTED_PATTERN.test(hint)) return { kind: "tools", message: MESSAGES.tools };
  if (TIMEOUT_PATTERN.test(hint)) return { kind: "network", message: MESSAGES.timeout };
  if (NETWORK_PATTERN.test(hint)) return { kind: "network", message: MESSAGES.network };

  // Reachable, but the tool test failed with no recognisable cause and no
  // hint at all: the model still can't be used for tools.
  if (result.reachable && !hint) return { kind: "tools", message: MESSAGES.tools };
  if (ALL_FAILED_PATTERN.test(hint)) return { kind: "unknown", message: MESSAGES.noAnswer };
  return { kind: "unknown", message: MESSAGES.unknown };
}
