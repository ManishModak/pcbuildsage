import type { LLMChainEntry } from "@/types";
import { keyEnv, normalizeBaseUrl, resolveApiKey } from "./client";
import { isFreePricing } from "./model-recommend";export type DiscoveredModel = {
  id: string;
  name?: string;
  contextLimit?: number;
  /** Raw OpenRouter `supported_parameters` (e.g. includes "tools" when tool calling is supported). */
  supportedParameters?: string[];
  /** Raw OpenRouter `pricing` (per-token prices as strings, e.g. "0" for free models). */
  pricing?: { prompt?: string | number; completion?: string | number };
  /** True when prompt+completion pricing are both zero. */
  free?: boolean;
  /** True when discovery metadata confirms tool calling; undefined when unknown. */
  toolCapable?: boolean;
};

export async function discoverModels(entry: LLMChainEntry, fetchImpl: typeof fetch = fetch): Promise<DiscoveredModel[]> {
  if (entry.provider === "gemini") {
    const key = resolveApiKey(entry, keyEnv(entry.provider));
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    if (key) url.searchParams.set("key", key);
    const json = await getJson<{ models?: Array<{ name: string; displayName?: string; inputTokenLimit?: number }> }>(url.toString(), fetchImpl);
    return (json.models ?? []).map((model) => ({
      id: model.name.replace(/^models\//, ""),
      name: model.displayName,
      contextLimit: typeof model.inputTokenLimit === "number" ? model.inputTokenLimit : undefined
    }));
  }
  if (entry.provider === "ollama") {
    const base = normalizeBaseUrl(entry.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434", "ollama");
    const json = await getJson<{ models?: Array<{ name: string; model?: string }> }>(`${base}/api/tags`, fetchImpl);
    const models = json.models ?? [];
    return Promise.all(
      models.map(async (model) => {
        const id = model.model ?? model.name;
        let contextLimit: number | undefined;
        try {
          const showData = await postJson<{
            modelfile?: string;
            parameters?: string;
            model_info?: Record<string, unknown>;
          }>(`${base}/api/show`, { model: id }, fetchImpl);
          contextLimit = parseOllamaModelContextLimit(showData);
        } catch {
          // If inspection fails or /api/show is unavailable, leave contextLimit undefined
        }
        return {
          id,
          name: model.name,
          contextLimit
        };
      })
    );
  }
  const defaultUrl =
    entry.provider === "openrouter"
      ? "https://openrouter.ai/api/v1"
      : entry.provider === "groq"
        ? "https://api.groq.com/openai/v1"
        : process.env.OPENAI_COMPATIBLE_BASE_URL ?? "http://localhost:8000/v1";
  const base = normalizeBaseUrl(entry.baseUrl ?? defaultUrl);
  const json = await getJson<{
    data?: Array<{
      id: string;
      name?: string;
      context_length?: number;
      context_window?: number;
      max_model_len?: number;
      supported_parameters?: string[];
      pricing?: { prompt?: string | number; completion?: string | number };
    }>;
  }>(`${base}/models`, fetchImpl, resolveApiKey(entry, keyEnv(entry.provider)));
  return (json.data ?? []).map((model) => {
    const rawLimit = model.context_length ?? model.context_window ?? model.max_model_len;
    const supportedParameters = Array.isArray(model.supported_parameters) ? model.supported_parameters : undefined;
    const toolCapable = supportedParameters
      ? supportedParameters.some((param) => param.toLowerCase() === "tools")
      : undefined;
    const free = isFreePricing(model.pricing);
    return {
      id: model.id,
      name: model.name || model.id,
      contextLimit: typeof rawLimit === "number" ? rawLimit : undefined,
      ...(supportedParameters ? { supportedParameters } : {}),
      ...(model.pricing ? { pricing: model.pricing } : {}),
      ...(free !== undefined ? { free } : {}),
      ...(toolCapable !== undefined ? { toolCapable } : {})
    };
  });
}

/**
 * True when OpenRouter-style pricing reports zero prompt+completion cost
 * (prices arrive as strings, e.g. "0" / "0.000000"). Returns undefined when
 * no pricing metadata is present so callers can distinguish "unknown".
 */
export { isFreePricing, isToolCapableModel, isFreeModel, groupModelsForPicker, pickFreeToolCapableDefault } from "./model-recommend";

/**
 * Parses the effective context limit from Ollama /api/show output.
 * If parameters or modelfile sets num_ctx <number>, that configured context size overrides
 * the model's trained maximum. Otherwise, reads *.context_length from model_info.
 */
export function parseOllamaModelContextLimit(showResponse: {
  modelfile?: string;
  parameters?: string;
  model_info?: Record<string, unknown>;
}): number | undefined {
  if (!showResponse || typeof showResponse !== "object") return undefined;

  // 1. Configured num_ctx overrides model maximum (check parameters first, then modelfile)
  if (typeof showResponse.parameters === "string") {
    const match = showResponse.parameters.match(/num_ctx\s+(\d+)/i);
    if (match && match[1]) {
      const parsed = parseInt(match[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }

  if (typeof showResponse.modelfile === "string") {
    const match = showResponse.modelfile.match(/(?:PARAMETER\s+)?num_ctx\s+(\d+)/i);
    if (match && match[1]) {
      const parsed = parseInt(match[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }

  // 2. Otherwise read *.context_length from model_info
  if (showResponse.model_info && typeof showResponse.model_info === "object") {
    for (const [key, val] of Object.entries(showResponse.model_info)) {
      if ((key.endsWith(".context_length") || key === "context_length") && typeof val === "number" && val > 0) {
        return val;
      }
    }
  }

  return undefined;
}

async function getJson<T>(url: string, fetchImpl: typeof fetch, apiKey?: string): Promise<T> {
  const response = await fetchImpl(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined });
  if (!response.ok) throw new Error(`Model discovery failed with HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function postJson<T>(url: string, body: unknown, fetchImpl: typeof fetch, apiKey?: string): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Model inspection failed with HTTP ${response.status}`);
  return (await response.json()) as T;
}

