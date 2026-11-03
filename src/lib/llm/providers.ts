/**
 * Every LLM provider PCBuildSage can talk to, in the order the app lists them
 * (free to start first). The provider type, key env vars, API base URLs, the
 * hosted demo's BYOK list and allowlist, the setup pickers and the CLI all read
 * this list, so a new OpenAI-compatible provider is one entry here.
 *
 * Client-safe: no Node imports and no process.env reads. Base URLs that come
 * from the environment (Ollama, your own server) are resolved in ./client.
 */

/** How the server reaches the provider. */
export type ProviderApi = "gemini" | "anthropic" | "openai-compatible" | "ollama";

/** What it costs to start: shown as the provider list's groups. */
export type ProviderTier = "free" | "trial" | "paid" | "local";

export type ProviderInfo = {
  id: string;
  /** Display name, e.g. "Google Gemini". */
  name: string;
  api: ProviderApi;
  tier: ProviderTier;
  /** One line on what you get, shown under the name. */
  note: string;
  /** Env var the server reads the key from. */
  envKey: string;
  /** Fixed API base for cloud providers; local ones take an address instead. */
  baseUrl?: string;
  /** Where to create a key. */
  keyUrl?: string;
  /** What a key looks like, as the key field's placeholder. */
  keyPlaceholder?: string;
  /**
   * Used only when model discovery found nothing and the user hasn't picked a
   * model. Empty for paid providers: the user picks, so nothing is billed by
   * default.
   */
  defaultModel?: string;
  /** Offered in the hosted demo, where keys are bring-your-own. */
  hosted: boolean;
};

export const LLM_PROVIDERS = [
  {
    id: "gemini",
    name: "Google Gemini",
    api: "gemini",
    tier: "free",
    note: "Free key from Google AI Studio",
    envKey: "GEMINI_API_KEY",
    keyUrl: "https://aistudio.google.com/app/apikey",
    keyPlaceholder: "AIzaSy...",
    defaultModel: "gemini-3.5-flash",
    hosted: true
  },
  {
    id: "groq",
    name: "Groq",
    api: "openai-compatible",
    tier: "free",
    note: "Free key, fast open models",
    envKey: "GROQ_API_KEY",
    baseUrl: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    keyPlaceholder: "gsk_...",
    defaultModel: "openai/gpt-oss-120b",
    hosted: true
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    api: "openai-compatible",
    tier: "free",
    note: "One key for hundreds of models; free ones allow 50 requests a day",
    envKey: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    keyPlaceholder: "sk-or-v1-...",
    // OpenRouter's router picks an available free model that can use tools.
    defaultModel: "openrouter/free",
    hosted: true
  },
  {
    id: "nvidia",
    name: "NVIDIA",
    api: "openai-compatible",
    tier: "free",
    note: "Free key for trying open models, about 40 requests a minute",
    envKey: "NVIDIA_API_KEY",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyUrl: "https://build.nvidia.com/settings/api-keys",
    keyPlaceholder: "nvapi-...",
    defaultModel: "nvidia/nemotron-3.5-super-vl-120b-a12b",
    hosted: true
  },
  {
    id: "cerebras",
    name: "Cerebras",
    api: "openai-compatible",
    tier: "trial",
    note: "Very fast open models; new accounts get trial credits",
    envKey: "CEREBRAS_API_KEY",
    baseUrl: "https://api.cerebras.ai/v1",
    keyUrl: "https://cloud.cerebras.ai/platform",
    keyPlaceholder: "csk-...",
    defaultModel: "gpt-oss-120b",
    hosted: true
  },
  {
    id: "openai",
    name: "OpenAI",
    api: "openai-compatible",
    tier: "paid",
    note: "GPT models, billed per token",
    envKey: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    keyPlaceholder: "sk-...",
    hosted: true
  },
  {
    id: "anthropic",
    name: "Anthropic",
    api: "anthropic",
    tier: "paid",
    note: "Claude models, billed per token",
    envKey: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com/v1",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyPlaceholder: "sk-ant-...",
    hosted: true
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    api: "openai-compatible",
    tier: "paid",
    note: "Low-cost models, billed per token",
    envKey: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com/v1",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyPlaceholder: "sk-...",
    hosted: true
  },
  {
    id: "xai",
    name: "xAI",
    api: "openai-compatible",
    tier: "paid",
    note: "Grok models, billed per token",
    envKey: "XAI_API_KEY",
    baseUrl: "https://api.x.ai/v1",
    keyUrl: "https://console.x.ai",
    keyPlaceholder: "xai-...",
    hosted: true
  },
  {
    id: "mistral",
    name: "Mistral",
    api: "openai-compatible",
    tier: "paid",
    note: "Mistral models, pay as you go",
    envKey: "MISTRAL_API_KEY",
    baseUrl: "https://api.mistral.ai/v1",
    keyUrl: "https://console.mistral.ai/api-keys",
    hosted: true
  },
  {
    id: "ollama",
    name: "Ollama",
    api: "ollama",
    tier: "local",
    note: "Models running on your machine",
    envKey: "OLLAMA_API_KEY",
    hosted: false
  },
  {
    id: "openai-compatible",
    name: "Your own server",
    api: "openai-compatible",
    tier: "local",
    note: "llama.cpp, LM Studio, vLLM or any OpenAI-compatible address",
    envKey: "OPENAI_COMPATIBLE_API_KEY",
    hosted: false
  }
] as const satisfies readonly ProviderInfo[];

export type LLMProvider = (typeof LLM_PROVIDERS)[number]["id"];

export const LLM_PROVIDER_IDS = LLM_PROVIDERS.map((provider) => provider.id) as [LLMProvider, ...LLMProvider[]];

/** Providers offered in the hosted demo, in display order. */
export const HOSTED_PROVIDER_IDS = LLM_PROVIDERS.filter((provider) => provider.hosted).map((provider) => provider.id);

const BY_ID: Record<string, ProviderInfo> = Object.fromEntries(LLM_PROVIDERS.map((provider) => [provider.id, provider]));

export function isLlmProvider(value: unknown): value is LLMProvider {
  return typeof value === "string" && value in BY_ID;
}

export function getProvider(id: LLMProvider): ProviderInfo;
export function getProvider(id: string): ProviderInfo | undefined;
export function getProvider(id: string): ProviderInfo | undefined {
  return BY_ID[id];
}

export function providerName(id: string): string {
  return BY_ID[id]?.name ?? id;
}

/** Runs on this machine or the LAN: takes an address and may need no key. */
export function isLocalProvider(id: string): boolean {
  return BY_ID[id]?.tier === "local";
}

export function isHostedProvider(id: string): boolean {
  return Boolean(BY_ID[id]?.hosted);
}
