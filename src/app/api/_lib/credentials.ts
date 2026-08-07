import { z } from "zod";
import { resolveConfig } from "@/lib/config";
import type { AppConfig, ConfigInput, LLMChainEntry, LLMProvider, SearchProvider } from "@/types";
import { resolveSandboxedPath } from "./paths";

const providerSchema = z.enum(["gemini", "ollama", "openrouter", "openai-compatible"]);
const keySourceSchema = z.enum(["env", "ui", "none"]);

export const llmEntrySchema = z.object({
  provider: providerSchema,
  model: z.string().min(1),
  keySource: keySourceSchema.default("env"),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional()
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
  searchProvider: z.enum(["exa", "tavily", "brave", "searxng", "duckduckgo", "gemini-native", "none"]).optional(),
  searchBaseUrl: z.string().optional(),
  searchApiKey: z.string().optional(),
  crawlEnabled: z.boolean().optional()
});

export function buildAppConfig(headers: Headers, bodyConfig: unknown = {}): AppConfig {
  const headerConfig = parseHeaderJson(headers.get("x-pcbuildsage-config"));
  const directConfig = sandboxConfig(configInputSchema.parse({ ...objectValue(headerConfig), ...objectValue(bodyConfig) }) as ConfigInput);
  const config = resolveConfig(directConfig);
  return injectRequestCredentials(config, headers);
}

export function entryFromRequest(input: unknown, headers: Headers): LLMChainEntry {
  const entry = llmEntrySchema.parse(input);
  return hydrateEntryCredential(entry, headers);
}

export function injectRequestCredentials(config: AppConfig, headers: Headers): AppConfig {
  const hydrateChain = (chain: LLMChainEntry[]) => chain.map((entry) => hydrateEntryCredential(entry, headers));
  const roles = {
    chat: hydrateChain(config.llm.roles.chat),
    subagent: hydrateChain(config.llm.roles.subagent),
    scraper: hydrateChain(config.llm.roles.scraper)
  };
  const searchApiKey =
    config.search.provider === "none"
      ? undefined
      : config.search.apiKey ?? headerApiKey(headers, searchHeaderProvider(config.search.provider));
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

export function getCredentialAvailability(env: NodeJS.ProcessEnv = process.env) {
  return {
    llm: {
      gemini: Boolean(env.GEMINI_API_KEY),
      openrouter: Boolean(env.OPENROUTER_API_KEY),
      ollama: Boolean(env.OLLAMA_BASE_URL || env.OLLAMA_API_KEY),
      "openai-compatible": Boolean(env.OPENAI_COMPATIBLE_API_KEY || env.OPENAI_COMPATIBLE_BASE_URL)
    },
    search: {
      brave: Boolean(env.BRAVE_API_KEY),
      exa: Boolean(env.EXA_API_KEY),
      tavily: Boolean(env.TAVILY_API_KEY),
      searxng: Boolean(env.SEARXNG_BASE_URL),
      duckduckgo: true,
      "gemini-native": Boolean(env.GEMINI_API_KEY)
    }
  };
}

function hydrateEntryCredential(entry: LLMChainEntry, headers: Headers): LLMChainEntry {
  if (entry.keySource === "none") return { ...entry, apiKey: undefined };
  if (entry.apiKey) return entry;
  const apiKey = entry.keySource === "ui" ? headerApiKey(headers, entry.provider) : process.env[providerEnvKey(entry.provider)];
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

function providerEnvKey(provider: LLMProvider): string {
  if (provider === "gemini") return "GEMINI_API_KEY";
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  if (provider === "ollama") return "OLLAMA_API_KEY";
  return "OPENAI_COMPATIBLE_API_KEY";
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
