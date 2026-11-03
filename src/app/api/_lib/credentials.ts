import { z } from "zod";
import { resolveConfig } from "@/lib/config";
import { getDeploymentMode, isHostedSearchProviderAllowed, validateChatProviderUrl, validateSearchBaseUrl, type DeploymentMode } from "@/lib/config/deployment";
import type { AppConfig, ConfigInput, LLMChainEntry, LLMProvider, SearchProvider } from "@/types";
import { envKeyAllowed } from "@/lib/llm/env-key-scope";
import { LLM_PROVIDERS, LLM_PROVIDER_IDS, getProvider } from "@/lib/llm/providers";
import { SEARCH_PROVIDER_IDS, normalizeSearchProvider } from "@/lib/search-providers";
import { resolveSandboxedPath } from "./paths";

export class UnsafeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeConfigError";
  }
}

export function assertSafeLlmChain(chain: LLMChainEntry[], mode: DeploymentMode): void {
  for (const entry of chain) {
    if (entry.provider === "ollama") {
      throw new UnsafeConfigError("Provider 'ollama' is not supported in hosted-demo mode.");
    }
    if (entry.provider === "openai-compatible" && !entry.baseUrl) {
      throw new UnsafeConfigError("Provider 'openai-compatible' requires an authorized HTTPS baseUrl in hosted-demo mode.");
    }
    if (entry.baseUrl) {
      const check = validateChatProviderUrl(entry.baseUrl, mode);
      if (!check.allowed) {
        throw new UnsafeConfigError(check.reason ?? `LLM provider URL "${entry.baseUrl}" is not permitted in hosted-demo mode.`);
      }
    }
  }
}

/**
 * Returns the search config that is safe to use for this deployment mode.
 * Local mode: unchanged. Hosted-demo mode: keyed providers (exa/tavily/brave)
 * are kept only when the request carries their key; gemini-native is kept
 * (it grounds through the user's own Gemini call, no server-side search).
 * Everything else (searxng, keyed-without-key) is coerced to "none".
 * Crawling is always off in hosted mode (it runs a headless browser on the
 * server); BYOK research stays on.
 * Throws UnsafeConfigError when a kept provider's baseUrl fails SSRF checks.
 */
export function assertSafeSearchConfig(search: AppConfig["search"], mode: DeploymentMode): AppConfig["search"] {
  if (mode === "local") return search;

  const provider = search.provider;
  const allowed = provider !== "none" && isHostedSearchProviderAllowed(provider, mode);
  const hasRequiredKey = provider === "gemini-native" || Boolean(search.apiKey);
  if (!allowed || !hasRequiredKey) {
    return { ...search, provider: "none", baseUrl: undefined, apiKey: undefined, crawlEnabled: false };
  }

  if (search.baseUrl && search.baseUrl.trim() !== "") {
    const check = validateSearchBaseUrl(search.baseUrl, mode);
    if (!check.allowed) {
      throw new UnsafeConfigError(check.reason ?? `Search endpoint URL "${search.baseUrl}" is not permitted in hosted-demo mode.`);
    }
  }
  return { ...search, crawlEnabled: false };
}

const providerSchema = z.enum(LLM_PROVIDER_IDS);
const keySourceSchema = z.enum(["env", "ui", "none"]);
const reasoningEffortSchema = z.enum(["low", "medium", "high"]);

export const llmEntrySchema = z.object({
  provider: providerSchema,
  model: z.string().min(1),
  keySource: keySourceSchema.default("env"),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  contextLimit: z.number().int().positive().optional()
});

const configInputSchema = z.object({
  dbPath: z.string().optional(),
  activeProfile: z.string().optional(),
  countryCode: z.string().regex(/^[A-Z]{2}$/).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  personality: z.string().optional(),
  theme: z.string().optional(),
  tier2Enabled: z.boolean().optional(),
  freeformConsultEnabled: z.boolean().optional(),
  llmChain: z.union([z.string(), z.array(llmEntrySchema)]).optional(),
  chatLlmChain: z.union([z.string(), z.array(llmEntrySchema)]).optional(),
  subagentLlmChain: z.union([z.string(), z.array(llmEntrySchema)]).optional(),
  scraperLlmChain: z.union([z.string(), z.array(llmEntrySchema)]).optional(),
  // Saved configs from before DuckDuckGo was removed still send it: read as "none".
  searchProvider: z.preprocess(normalizeSearchProvider, z.enum(SEARCH_PROVIDER_IDS)).optional(),
  searchBaseUrl: z.string().optional(),
  searchApiKey: z.string().optional(),
  crawlEnabled: z.boolean().optional()
});

export function buildAppConfig(headers: Headers, bodyConfig: unknown = {}): AppConfig {
  const headerConfig = parseHeaderJson(headers.get("x-pcbuildsage-config"));
  const directConfig = sandboxConfig(configInputSchema.parse({ ...objectValue(headerConfig), ...objectValue(bodyConfig) }) as ConfigInput);
  const config = resolveConfig(directConfig);
  const hydrated = injectRequestCredentials(config, headers);

  const mode = getDeploymentMode();
  if (mode === "hosted-demo") {
    assertSafeLlmChain(hydrated.llm.chain, mode);
    assertSafeLlmChain(hydrated.llm.roles.chat, mode);
    assertSafeLlmChain(hydrated.llm.roles.subagent, mode);
    assertSafeLlmChain(hydrated.llm.roles.scraper, mode);
    return { ...hydrated, search: assertSafeSearchConfig(hydrated.search, mode) };
  }

  return hydrated;
}

export function entryFromRequest(input: unknown, headers: Headers): LLMChainEntry {
  const entry = llmEntrySchema.parse(input);
  return hydrateEntryCredential(entry, headers);
}

export function injectRequestCredentials(config: AppConfig, headers: Headers): AppConfig {
  const mode = getDeploymentMode();
  const hydrateChain = (chain: LLMChainEntry[]) => chain.map((entry) => hydrateEntryCredential(entry, headers, mode));
  const roles = {
    chat: hydrateChain(config.llm.roles.chat),
    subagent: hydrateChain(config.llm.roles.subagent),
    scraper: hydrateChain(config.llm.roles.scraper)
  };
  const searchApiKey =
    config.search.provider === "none"
      ? undefined
      : mode === "hosted-demo"
        ? headerApiKey(headers, searchHeaderProvider(config.search.provider))
        : (config.search.apiKey ?? headerApiKey(headers, searchHeaderProvider(config.search.provider)));
  return {
    ...config,
    llm: {
      chain: hydrateChain(config.llm.chain),
      roles
    },
    search: {
      ...config.search,
      apiKey: searchApiKey
    }
  };
}

export function getCredentialAvailability(env: NodeJS.ProcessEnv = process.env, mode: DeploymentMode = getDeploymentMode(env)) {
  const local = mode !== "hosted-demo";
  const llm = Object.fromEntries(
    LLM_PROVIDERS.map((provider) => [provider.id, local && llmEnvConfigured(provider.id, env)])
  ) as Record<LLMProvider, boolean>;
  return {
    llm,
    search: {
      brave: local && Boolean(env.BRAVE_API_KEY),
      exa: local && Boolean(env.EXA_API_KEY),
      tavily: local && Boolean(env.TAVILY_API_KEY),
      searxng: local && Boolean(env.SEARXNG_BASE_URL),
      "gemini-native": local && Boolean(env.GEMINI_API_KEY)
    }
  };
}

// Local providers count as set up when their address is set, even with no key.
function llmEnvConfigured(provider: LLMProvider, env: NodeJS.ProcessEnv): boolean {
  if (env[getProvider(provider).envKey]) return true;
  if (provider === "ollama") return Boolean(env.OLLAMA_BASE_URL);
  if (provider === "openai-compatible") return Boolean(env.OPENAI_COMPATIBLE_BASE_URL);
  return false;
}

function hydrateEntryCredential(entry: LLMChainEntry, headers: Headers, mode: DeploymentMode = getDeploymentMode()): LLMChainEntry {
  if (entry.keySource === "none") return { ...entry, apiKey: undefined };
  // In hosted-demo mode, ephemeral BYOK keys must strictly originate from request headers
  if (mode === "hosted-demo") {
    const apiKey = headerApiKey(headers, entry.provider);
    return { ...entry, apiKey };
  }
  if (entry.apiKey) return entry;
  const apiKey =
    entry.keySource === "ui"
      ? headerApiKey(headers, entry.provider)
      : envKeyAllowed(entry)
        ? process.env[getProvider(entry.provider).envKey]
        : undefined;
  return apiKey ? { ...entry, apiKey } : entry;
}

function headerApiKey(headers: Headers, provider: string): string | undefined {
  const normalized = provider.toLowerCase();
  const underscore = normalized.replace(/-/g, "_");
  return (
    headers.get(`x-pcbuildsage-api-key-${normalized}`) ??
    headers.get(`x-pcbuildsage-api-key-${underscore}`) ??
    headers.get(`x-${normalized}-api-key`) ??
    headers.get(`x-${underscore}-api-key`) ??
    undefined
  );
}

function searchHeaderProvider(provider: SearchProvider): string {
  if (provider === "gemini-native") return "gemini";
  return provider;
}

function parseHeaderJson(value: string | null): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("x-pcbuildsage-config must contain valid JSON.");
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sandboxConfig(config: ConfigInput): ConfigInput {
  return config.dbPath ? { ...config, dbPath: resolveSandboxedPath(config.dbPath) } : config;
}
