import type { LLMChainEntry } from "@/types";
import { keyEnv, normalizeBaseUrl, resolveApiKey } from "./client";

export type DiscoveredModel = { id: string; name?: string; contextLimit?: number };

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
    return (json.models ?? []).map((model) => ({ id: model.model ?? model.name, name: model.name }));
  }
  const defaultUrl =
    entry.provider === "openrouter"
      ? "https://openrouter.ai/api/v1"
      : entry.provider === "groq"
        ? "https://api.groq.com/openai/v1"
        : "http://localhost:8000/v1";
  const base = normalizeBaseUrl(entry.baseUrl ?? defaultUrl);
  const json = await getJson<{
    data?: Array<{
      id: string;
      name?: string;
      context_length?: number;
      context_window?: number;
      max_model_len?: number;
    }>;
  }>(`${base}/models`, fetchImpl, resolveApiKey(entry, keyEnv(entry.provider)));
  return (json.data ?? []).map((model) => {
    const rawLimit = model.context_length ?? model.context_window ?? model.max_model_len;
    return {
      id: model.id,
      name: model.name || model.id,
      contextLimit: typeof rawLimit === "number" ? rawLimit : undefined
    };
  });
}

async function getJson<T>(url: string, fetchImpl: typeof fetch, apiKey?: string): Promise<T> {
  const response = await fetchImpl(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined });
  if (!response.ok) throw new Error(`Model discovery failed with HTTP ${response.status}`);
  return (await response.json()) as T;
}
