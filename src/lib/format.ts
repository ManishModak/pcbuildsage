// Formatting helpers. Prices are integer minor units everywhere in the API;
// these render them for display. Kept framework-agnostic and unit-tested.

const CURRENCY_MINOR_DIGITS: Record<string, number> = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KRW: 0
};

export function minorDigits(currency: string): number {
  return CURRENCY_MINOR_DIGITS[currency.toUpperCase()] ?? 2;
}
/**
 * Format an integer minor-unit price (e.g. paise, cents) for the given currency.
 * Returns a plain string; callers render it in mono with tabular-nums.
 */
export function formatPrice(
  major: number | null | undefined,
  currency: string,
  locale?: string
): string {
  if (major === null || major === undefined || Number.isNaN(major)) return "—";
  const digits = minorDigits(currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(major);
  } catch {
    // Unknown currency code: fall back to a symbol-less grouped number.
    return `${currency.toUpperCase()} ${major.toLocaleString(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    })}`;
  }
}

export function sumPrices(prices: Array<number | null | undefined>): number {
  return prices.reduce<number>((total, price) => total + (typeof price === "number" ? price : 0), 0);
}

export function formatLatency(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatRelativeTime(iso: string | Date | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = Math.round((then - now) / 1000);
  const abs = Math.abs(diff);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1]
  ];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, seconds] of units) {
    if (abs >= seconds) {
      return rtf.format(Math.round(diff / seconds), unit);
    }
  }
  return rtf.format(diff, "second");
}

export function formatClock(iso: string | Date | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const sameDay = new Date(then).toDateString() === new Date(now).toDateString();
  return new Date(then).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    ...(sameDay ? {} : { month: "short", day: "numeric" })
  });
}

/** Estimate crawl time from selected sites × categories × page depth, accounting for parallel site workers. */
export function estimateScrapeMinutes(
  jobs: number,
  pages: number,
  delayMs = 1000,
  concurrency = 1,
  siteCount = 1
): { pages: number; label: string } {
  const effectiveWorkers = Math.max(1, Math.min(Math.max(1, siteCount), Math.max(1, concurrency)));
  const seconds = Math.max(1, Math.round((pages * (2.5 + delayMs / 1000)) / effectiveWorkers));
  const minutes = Math.round(seconds / 60);
  return { pages, label: minutes >= 1 ? `~${minutes} min` : `~${seconds} sec` };
}

export function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function getErrorMessageText(msg: string): string {
  if (!msg) return "";
  if (msg.includes("Headers Timeout Error")) {
    return "Connection timed out waiting for the model to respond (Headers Timeout Error). If you are using a local model (Ollama / Unsloth / vLLM), verify the local server is running and finished loading the model weights into memory, or add a fallback provider in Settings.";
  }

  let extracted = msg;
  try {
    const parsed = JSON.parse(msg);
    if (parsed && typeof parsed === "object") {
      if (parsed.message) extracted = String(parsed.message);
      else if (parsed.error && typeof parsed.error === "object" && parsed.error.message) {
        extracted = String(parsed.error.message);
      } else if (typeof parsed.error === "string") extracted = parsed.error;
    }
  } catch {
    // Ignore
  }

  if (extracted === msg) {
    const jsonStart = msg.indexOf("{");
    const jsonEnd = msg.lastIndexOf("}");
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      try {
        const jsonSub = msg.slice(jsonStart, jsonEnd + 1);
        const parsed = JSON.parse(jsonSub);
        if (parsed && typeof parsed === "object") {
          if (parsed.message) extracted = String(parsed.message);
          else if (parsed.error && typeof parsed.error === "object" && parsed.error.message) {
            extracted = String(parsed.error.message);
          } else if (typeof parsed.error === "string") extracted = parsed.error;
        }
      } catch {
        // Ignore
      }
    }
  }

  const combined = `${msg} ${extracted}`.toLowerCase();

  const isDailyQuota =
    combined.includes("free-models-per-day") ||
    combined.includes("daily-quota") ||
    combined.includes("daily quota") ||
    combined.includes("daily limit") ||
    (combined.includes("per day") && (combined.includes("quota") || combined.includes("limit") || combined.includes("exhausted")));

  if (isDailyQuota) {
    const detail = extracted !== msg ? extracted : (msg.length < 120 ? msg : "");
    const resetMatch = msg.match(/(?:resets?|retry)(?:\s+(?:at|in|-after))?\s+([^,;.)]+)/i);
    const timingInfo = resetMatch ? ` (${resetMatch[0].trim()})` : "";
    return `The provider reports that its daily free-model quota is exhausted. Try again after it resets${timingInfo}, or check your provider settings.${detail ? ` Details: ${detail}` : ""}`;
  }

  if (
    combined.includes("429") ||
    combined.includes("rate limit") ||
    combined.includes("rate_limit") ||
    combined.includes("too many requests") ||
    combined.includes("resource_exhausted") ||
    combined.includes("quota exceeded") ||
    combined.includes("tokens per minute") ||
    combined.includes("requests per minute") ||
    combined.includes("free-tier limit")
  ) {
    const detail = extracted !== msg ? extracted : (msg.length < 120 ? msg : "");
    return `Rate limit or quota reached (HTTP 429). The model provider temporarily rejected the request because token or request limits were exceeded. Please wait a moment before trying again, or configure an alternative provider/key in Settings.${detail ? ` Details: ${detail}` : ""}`;
  }

  if (
    combined.includes("context_length_exceeded") ||
    combined.includes("maximum context length") ||
    combined.includes("context window") ||
    (combined.includes("token limit") && combined.includes("exceeded"))
  ) {
    const detail = extracted !== msg ? extracted : (msg.length < 120 ? msg : "");
    return `Context length limit exceeded. The conversation history or tool output was too long for this model's context window. Try starting a new chat or narrowing search filters.${detail ? ` Details: ${detail}` : ""}`;
  }

  if (
    combined.includes("503") ||
    combined.includes("service unavailable") ||
    combined.includes("model is overloaded")
  ) {
    const detail = extracted !== msg ? extracted : (msg.length < 120 ? msg : "");
    return `The model provider is temporarily overloaded or unavailable (HTTP 503). Please wait a moment and try again, or switch to another model in Settings.${detail ? ` Details: ${detail}` : ""}`;
  }

  if (combined.includes("provider returned error")) {
    const detail = extracted !== msg && extracted.length < 200 ? extracted : "";
    return `The model provider returned an error (likely rate limit, timeout, or service interruption). Check your API keys and provider chain in Settings and try again.${detail ? ` Details: ${detail}` : ""}`;
  }

  return extracted;
}

const FALLBACK_ERROR_MESSAGE =
  "Something interrupted the response. Check your provider chain in settings and try again.";

export function getErrorMessage(error: unknown): string {
  let message = "";

  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "object" && error !== null) {
    const errObj = error as Record<string, unknown>;
    if ("message" in errObj && errObj.message && typeof errObj.message !== "object") {
      message = String(errObj.message);
    } else {
      try {
        const json = JSON.stringify(error);
        if (json && json !== "{}") {
          message = json;
        }
      } catch {
        // Serialization failed (e.g. circular reference)
      }
    }
  } else {
    message = String(error ?? "");
  }

  if (!message || message === "[object Object]") {
    return FALLBACK_ERROR_MESSAGE;
  }

  const result = getErrorMessageText(message);
  if (!result || result === "[object Object]") {
    return FALLBACK_ERROR_MESSAGE;
  }

  return result;
}

/** Format raw model identifiers or filesystem paths into a concise, readable model name. */
export function formatModelName(model: string | undefined): string {
  if (!model || typeof model !== "string") return "Sage";
  let name = model.trim();
  if (!name) return "Sage";

  // If it's a filepath (contains slashes or backslashes), grab the filename
  if (name.includes("/") || name.includes("\\")) {
    const parts = name.split(/[/\\]/);
    const filename = parts.pop() || "";
    if (filename) {
      name = filename;
    }
  }

  // Strip .gguf / .bin / .safetensors / .pt / .onnx extensions
  name = name.replace(/\.(gguf|bin|safetensors|pt|onnx)$/i, "");

  // If it looks like HuggingFace models--org--repo
  if (name.startsWith("models--")) {
    name = name.replace(/^models--/, "").replace(/--/g, "/");
  }

  // If prefixed with a provider like 'ollama:llama3.3' or 'gemini:gemini-2.5-flash', strip the prefix
  name = name.replace(/^(ollama|gemini|openrouter|openai-compatible):/i, "");

  return name || "Sage";
}

const STARTER_BUDGET_TARGETS: Record<string, number> = {
  INR: 90000,
  USD: 1200,
  EUR: 1100,
  GBP: 1000,
  CAD: 1600,
  AUD: 1800,
  JPY: 180000,
  KRW: 1600000,
  BRL: 6500,
  AED: 4500,
  SGD: 1600,
  NZD: 2000,
  CHF: 1100,
  SEK: 13000,
  NOK: 13000,
  DKK: 8500,
  PLN: 5000,
  CZK: 28000,
  HUF: 450000,
  RON: 5500,
  TRY: 40000,
  ZAR: 22000,
  MXN: 22000,
  TWD: 38000,
  THB: 42000,
  MYR: 5500,
  PHP: 68000,
  IDR: 19000000,
  VND: 30000000,
  SAR: 4500,
  ILS: 4500,
  CLP: 1100000,
  COP: 4800000,
  PEN: 4500,
  ARS: 1200000
};

/** Format a rounded 1440p gaming build budget string for any world currency. */
export function formatStarterBudget(currency?: string, locale?: string): string {
  const code = (currency || "INR").trim().toUpperCase();
  const amount = STARTER_BUDGET_TARGETS[code] ?? 1200;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      maximumFractionDigits: 0
    }).format(amount);
  } catch {
    return `${code} ${amount.toLocaleString(locale)}`;
  }
}
