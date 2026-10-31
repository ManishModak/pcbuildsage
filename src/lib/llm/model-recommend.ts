import type { DiscoveredModel } from "@/types/client";

/**
 * True when OpenRouter-style pricing reports zero prompt+completion cost
 * (prices arrive as strings, e.g. "0" / "0.000000"). Returns undefined when
 * no pricing metadata is present so callers can distinguish "unknown".
 */
export function isFreePricing(pricing?: { prompt?: string | number; completion?: string | number }): boolean | undefined {
  if (!pricing) return undefined;
  const prompt = Number(pricing.prompt ?? NaN);
  const completion = Number(pricing.completion ?? NaN);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return undefined;
  return prompt === 0 && completion === 0;
}

/** True when the model's own flag or its supported_parameters confirm tool calling. */
export function isToolCapableModel(model: Pick<DiscoveredModel, "toolCapable" | "supportedParameters">): boolean {
  if (model.toolCapable === true) return true;
  return (model.supportedParameters ?? []).some((param) => param.toLowerCase() === "tools");
}

/** True when the model's own flag or its pricing metadata reports zero cost. */
export function isFreeModel(model: Pick<DiscoveredModel, "free" | "pricing">): boolean {
  if (model.free === true) return true;
  return isFreePricing(model.pricing) === true;
}

/**
 * Splits a discovered list into a "Recommended" group (tool-capable, free
 * first) and everything else, using discovery metadata only. Providers that
 * expose no supported_parameters (Gemini, Groq, local servers) yield an empty
 * recommended group so their list renders as today.
 */
export function groupModelsForPicker<T extends Pick<DiscoveredModel, "id" | "toolCapable" | "supportedParameters" | "free" | "pricing">>(
  models: T[]
): { recommended: T[]; rest: T[] } {
  const recommended = models
    .filter((model) => isToolCapableModel(model))
    .sort((a, b) => Number(isFreeModel(b)) - Number(isFreeModel(a)));
  const recommendedIds = new Set(recommended.map((model) => model.id));
  return { recommended, rest: models.filter((model) => !recommendedIds.has(model.id)) };
}

/** Id tokens marking a domain-tuned variant (health, finance, code, ...), not a general assistant. */
const SPECIALIST_TOKENS = new Set(["sante", "health", "med", "medical", "fin", "finance", "code", "coder", "math", "guard", "safety"]);
/** Name tokens hinting at a small model; used only when the id has no parsable size. */
const SMALL_HINT_TOKENS = new Set(["nano", "lite", "mini", "small", "xs", "tiny"]);
/** Parameter counts below this (in billions) are too small to default to. */
const MIN_DEFAULT_PARAMS_B = 20;

/**
 * Largest total parameter count in an id, in billions ("lfm-2.5-2.6b" → 2.6,
 * "nemotron-3-nano-omni-30b-a3b" → 30; "a3b" active-param counts are ignored).
 */
export function parseParamsBillions(id: string): number | undefined {
  const sizes = [...id.toLowerCase().matchAll(/(?<![a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z0-9])/g)].map((m) => Number(m[1]));
  return sizes.length > 0 ? Math.max(...sizes) : undefined;
}

/**
 * How suitable an id is as an automatic default: 0 = general model of
 * reasonable size, 1 = general model with a small-name hint (nano/lite/mini),
 * 2 = specialist or parsably tiny (skip).
 */
export function defaultSuitability(id: string): 0 | 1 | 2 {
  const lower = id.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1).replace(/:[^:]*$/, "");
  const tokens = name.split(/[-_.\s]+/);
  if (tokens.some((token) => SPECIALIST_TOKENS.has(token))) return 2;
  const params = parseParamsBillions(name);
  if (params !== undefined) return params < MIN_DEFAULT_PARAMS_B ? 2 : 0;
  return tokens.some((token) => SMALL_HINT_TOKENS.has(token)) ? 1 : 0;
}

/**
 * Picks a default from discovered models: the first free + tool-capable
 * general model in discovery order, skipping domain-tuned variants (-sante,
 * -fin, -code, ...) and tiny models (<20B, or nano/lite/mini as a weaker
 * hint). Falls back to the first free + tool-capable model, else the first
 * tool-capable model, else undefined (caller asks the user to pick). Only
 * the default: users can still pick any model. Never hard-codes a model ID.
 */
export function pickFreeToolCapableDefault<T extends Pick<DiscoveredModel, "id" | "toolCapable" | "supportedParameters" | "free" | "pricing">>(
  models: T[]
): T | undefined {
  const { recommended } = groupModelsForPicker(models);
  const free = recommended.filter((model) => isFreeModel(model));
  return (
    free.find((model) => defaultSuitability(model.id) === 0) ??
    free.find((model) => defaultSuitability(model.id) === 1) ??
    free[0] ??
    recommended[0]
  );
}
