import type { LLMChainEntry } from "./config-types";
import { keyEnv, normalizeBaseUrl, resolveApiKey } from "./llm-client";

export type DiscoveredModel = { id: string; name?: string };

export async function discoverModels(entry: LLMChainEntry, fetchImpl: typeof fetch = fetch): Promise<DiscoveredModel[]> {
  if (entry.provider === "gemini") {
    const key = resolveApiKey(entry, keyEnv(entry.provider));
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    if (key) url.searchParams.set("key", key);
    const json = await getJson<{ models?: Array<{ name: string; displayName?: string }> }>(url.toString(), fetchImpl);
    return (json.models ?? []).map((model) => ({ id: model.name.replace(/^models\//, ""), name: model.displayName }));
  }
  if (entry.provider === "ollama") {
    const base = normalizeBaseUrl(entry.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434", "ollama");
    const json = await getJson<{ models?: Array<{ name: string; model?: string }> }>(`${base}/api/tags`, fetchImpl);
    return (json.models ?? []).map((model) => ({ id: model.model ?? model.name, name: model.name }));
  }
  const base = normalizeBaseUrl(entry.baseUrl ?? (entry.provider === "openrouter" ? "https://openrouter.ai/api/v1" : "http://localhost:8000/v1"));
  const json = await getJson<{ data?: Array<{ id: string; name?: string }> }>(`${base}/models`, fetchImpl, resolveApiKey(entry, keyEnv(entry.provider)));
  return (json.data ?? []).map((model) => ({ id: model.id, name: model.name }));
}

async function getJson<T>(url: string, fetchImpl: typeof fetch, apiKey?: string): Promise<T> {
  const response = await fetchImpl(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined });
  if (!response.ok) throw new Error(`Model discovery failed with HTTP ${response.status}`);
  return (await response.json()) as T;
}
