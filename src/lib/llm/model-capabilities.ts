import type { DiscoveredModel } from "@/types/client";

/**
 * Client-safe model capability helpers: Gemini thought/thinkingLevel support,
 * per-model reasoning effort visibility, and free-tier token-limit warnings.
 */

const NON_TEXT_GEMINI_PATTERN = /(image|embedding|tts|live)/;

/** Normalize a model ID for family matching (lowercase, strip `models/` prefix). */
function normalizeGeminiId(model: string): string {
  return model.trim().toLowerCase().replace(/^models\//, "");
}

/**
 * Gemini 4.x models. `@ai-sdk/google` 4.0.11 only recognizes `gemini-3[.-]` for
 * `thinkingLevel`, so `gemini-4*` must receive `thinkingConfig.thinkingLevel`
 * directly without top-level `reasoning` (which would send `thinkingBudget`).
 */
export function isGemini4Model(model: string): boolean {
  const id = normalizeGeminiId(model);
  if (NON_TEXT_GEMINI_PATTERN.test(id)) return false;
  return /^gemini-4(?:[.-]|$)/.test(id);
}

/**
 * Models that think by default and emit thought summaries when `includeThoughts`
 * is requested. Every Gemini 4 and 3 model thinks by default; in the 2.5 series
 * Pro and Flash think by default, whereas 2.5 Flash-Lite has thinking off unless
 * an explicit reasoning effort is requested.
 */
export function supportsGeminiThoughts(model: string): boolean {
  const id = normalizeGeminiId(model);
  if (NON_TEXT_GEMINI_PATTERN.test(id)) return false;
  if (/^gemini-(3|4)(?:[.-]|$)/.test(id)) return true;
  if (/^gemini-2\.5/.test(id)) return !id.includes("lite");
  return false;
}

/**
 * Gemini text models that accept an explicit reasoning-effort setting:
 * Gemini 4 and 3 use `thinkingLevel`; Gemini 2.5 (including 2.5 Flash-Lite's
 * optional thinking) uses `thinkingBudget`.
 */
export function supportsGeminiReasoning(model: string): boolean {
  const id = normalizeGeminiId(model);
  if (NON_TEXT_GEMINI_PATTERN.test(id)) return false;
  return /^gemini-(?:2\.5|3|4)(?:[.-]|$)/.test(id);
}

const REASONING_PARAMS = new Set(["reasoning", "include_reasoning"]);

/**
 * Whether the in-chat model picker should expose reasoning-effort controls
 * for this (provider, modelId) pair.
 *
 * Groq is always hidden because `sanitizeOpenAICompatibleRequestBody` strips
 * `reasoning_effort` for Groq endpoints. Non-thinking models (Gemini 2.0,
 * GPT-4o/4.1, Llama 3.x, Claude 3.5, DeepSeek Chat) are hidden as well.
 */
export function supportsReasoning(
  provider: string,
  modelId: string,
  meta?: Pick<DiscoveredModel, "supportedParameters">
): boolean {
  const normalizedProvider = provider.trim().toLowerCase();
  if (normalizedProvider === "groq") return false;

  const rawId = modelId.trim().toLowerCase();
  if (!rawId) return false;

  if (meta?.supportedParameters?.some((param) => REASONING_PARAMS.has(param.toLowerCase()))) {
    return true;
  }

  const withoutPrefix = rawId.replace(/^models\//, "");
  const base = withoutPrefix.slice(withoutPrefix.lastIndexOf("/") + 1).replace(/:[^:]*$/, "");

  if (normalizedProvider === "gemini" || withoutPrefix.startsWith("google/gemini-")) {
    return supportsGeminiReasoning(base);
  }

  // OpenAI o-series (o1, o3, o4...), GPT-5+, gpt-oss, codex-mini
  if (/^o[1-9](?:$|[-.])/.test(base)) return true;
  if (/^gpt-([5-9]|\d{2,})(?:$|[-.])/.test(base) && !base.includes("-chat")) return true;
  if (/^gpt-oss(?:$|[-.])/.test(base)) return true;
  if (/^codex-mini(?:$|[-.])/.test(base)) return true;

  // Anthropic Claude 3.7+ and Claude 4+ (sonnet-4, opus-4, haiku-4-5, claude-4-*)
  if (/^claude-(?:3[.-]7|[4-9]|\d{2,}|(?:sonnet|opus|haiku)-[4-9])/.test(base)) return true;

  // DeepSeek R1 / Reasoner and generic explicit reasoning/thinking model names
  if (/(?:^|[-_.])(r1|reasoner|reasoning|thinking|qwq)(?:$|[-_.0-9])/.test(base)) return true;

  // Qwen3 (non-Groq, e.g. Ollama / OpenAI-compatible / OpenRouter / Cerebras)
  if (/^qwen3(?:$|[-.])/.test(base)) return true;

  // xAI Grok reasoning models (grok-3-mini, grok-4+)
  if (/^grok-3-mini(?:$|[-.])/.test(base)) return true;
  if (/^grok-([4-9]|\d{2,})(?:$|[-.])/.test(base)) return true;

  // Mistral Magistral reasoning models
  if (/^magistral(?:$|[-.])/.test(base)) return true;

  return false;
}

export interface FreeTierWarning {
  badge: string;
  detail: string;
}

const GROQ_FREE_TIER_MODEL_TPM: Record<string, string> = {
  "openai/gpt-oss-120b": "8K",
  "openai/gpt-oss-safeguard-20b": "2K"
};

/**
 * Flags providers/models whose free tier has tight TPM caps compared to the
 * 15–25K tokens per step typical of a full PC build turn.
 */
export function getFreeTierWarning(provider: string, modelId?: string): FreeTierWarning | null {
  if (provider.trim().toLowerCase() !== "groq") return null;

  const normalizedModel = modelId?.trim().toLowerCase() ?? "";
  const specificTpm = normalizedModel ? GROQ_FREE_TIER_MODEL_TPM[normalizedModel] : undefined;
  if (specificTpm) {
    return {
      badge: `${specificTpm} TPM free limit`,
      detail: `Groq's free tier for ${modelId} is ${specificTpm} tokens/min (limits vary by model and org), too small for full PC builds (15–25K tokens/step). Use a paid tier or another provider for full builds.`
    };
  }

  return {
    badge: "Low TPM free limit",
    detail: "Groq's free tier has tight token-per-minute limits (e.g. 8K TPM on the default openai/gpt-oss-120b; limits vary by model and org), often too small for full PC builds (15–25K tokens/step). Use a paid tier or another provider for full builds."
  };
}
