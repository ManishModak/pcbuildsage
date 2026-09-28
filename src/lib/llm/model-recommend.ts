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

/**
 * Picks a default from discovered models: first free + tool-capable model,
 * else first tool-capable model, else undefined (caller asks the user to
 * pick). Never hard-codes a model ID.
 */
export function pickFreeToolCapableDefault<T extends Pick<DiscoveredModel, "id" | "toolCapable" | "supportedParameters" | "free" | "pricing">>(
  models: T[]
): T | undefined {
  const { recommended } = groupModelsForPicker(models);
  return recommended.find((model) => isFreeModel(model)) ?? recommended[0];
}
