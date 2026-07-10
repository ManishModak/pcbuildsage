import path from "node:path";
import { DEFAULT_DB_PATH } from "./db";
import type { AppConfig, ConfigInput, LLMChainEntry, LLMProvider, LLMRole, RoleChains, SearchProvider } from "./config-types";
import { normalizeBaseUrl } from "./llm-client";

const DEFAULT_CHAIN = "gemini:gemini-2.5-flash,ollama:llama3.3";
const ROLES: LLMRole[] = ["chat", "subagent", "scraper"];

export function parseLlmChain(value?: string | LLMChainEntry[]): LLMChainEntry[] {
  if (Array.isArray(value)) {
    return value.map((entry) => hydrateEntry(entry));
  }

  const source = value?.trim() || DEFAULT_CHAIN;
  return source
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [provider, ...modelParts] = item.split(":");
      const model = modelParts.join(":").trim();
      if (!isProvider(provider) || !model) {
        throw new Error(`Invalid LLM chain entry "${item}". Expected provider:model.`);
      }
      return hydrateEntry({ provider, model, keySource: "env" });
    });
}

export function resolveConfig(uiOrFlags: ConfigInput = {}, savedConfig: ConfigInput = {}, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const source = <T>(key: keyof ConfigInput, envKey: string, fallback: T): T =>
    (uiOrFlags[key] as T | undefined) ?? (savedConfig[key] as T | undefined) ?? ((env[envKey] as T | undefined) ?? fallback);

  const llmChain = parseLlmChain(source("llmChain", "LLM_CHAIN", DEFAULT_CHAIN));
  const roleEnv: Record<LLMRole, string> = {
    chat: "CHAT_LLM_CHAIN",
    subagent: "SUBAGENT_LLM_CHAIN",
    scraper: "SCRAPER_LLM_CHAIN"
  };
  const roleInput: Record<LLMRole, keyof ConfigInput> = {
    chat: "chatLlmChain",
    subagent: "subagentLlmChain",
    scraper: "scraperLlmChain"
  };
  const roles = Object.fromEntries(
    ROLES.map((role) => [role, parseLlmChain(source(roleInput[role], roleEnv[role], llmChain))])
  ) as RoleChains;

  const searchProvider = source<SearchProvider>("searchProvider", "SEARCH_PROVIDER", "none");
  const countryCode = validateCode("countryCode", source("countryCode", "PCBUILDSAGE_COUNTRY", "IN"), /^[A-Z]{2}$/);
  const currency = validateCode("currency", source("currency", "PCBUILDSAGE_CURRENCY", "INR"), /^[A-Z]{3}$/);
  return {
    dbPath: path.resolve(source("dbPath", "PCBUILDSAGE_DB_PATH", DEFAULT_DB_PATH)),
    activeProfile: source<string | undefined>("activeProfile", "PCBUILDSAGE_PROFILE", undefined),
    countryCode,
    currency,
    persona: source("persona", "PCBUILDSAGE_PERSONA", "balanced-showpiece"),
    personas: normalizePersonaList(source<string[] | string | undefined>("personas", "PCBUILDSAGE_PERSONAS", undefined)),
    personality: source("personality", "PCBUILDSAGE_PERSONALITY", "helpful-consultant"),
    theme: source("theme", "PCBUILDSAGE_THEME", "sage-dark"),
    tier2Enabled: coerceBool(source("tier2Enabled", "PCBUILDSAGE_TIER2", "true")),
    freeformConsultEnabled: coerceBool(source("freeformConsultEnabled", "PCBUILDSAGE_CONSULT_FREEFORM", "false")),
    llm: { chain: llmChain, roles },
    search: {
      provider: searchProvider,
      baseUrl: source<string | undefined>("searchBaseUrl", "SEARXNG_BASE_URL", undefined),
      apiKey: source<string | undefined>("searchApiKey", providerKeyEnv(searchProvider), undefined)
    }
  };
}

function normalizePersonaList(value: string[] | string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : value.split(",").map((item) => item.trim());
  const filtered = list.filter(Boolean);
  return filtered.length > 0 ? filtered : undefined;
}

function hydrateEntry(entry: LLMChainEntry): LLMChainEntry {
  const baseUrl = entry.baseUrl ?? defaultBaseUrl(entry.provider);
  return {
    ...entry,
    keySource: entry.keySource ?? "env",
    baseUrl: baseUrl ? normalizeBaseUrl(baseUrl, entry.provider === "ollama" ? "ollama" : "openai-compatible") : undefined
  };
}

function defaultBaseUrl(provider: LLMProvider): string | undefined {
  if (provider === "ollama") return process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  if (provider === "openrouter") return "https://openrouter.ai/api/v1";
  return undefined;
}

function providerKeyEnv(provider: SearchProvider): string {
  return `${provider.toUpperCase().replace("-", "_")}_API_KEY`;
}

function isProvider(value: string): value is LLMProvider {
  return value === "gemini" || value === "ollama" || value === "openrouter" || value === "openai-compatible";
}

function coerceBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return String(value).toLowerCase() === "true" || value === "1";
}

function validateCode(name: string, value: string, pattern: RegExp): string {
  if (!pattern.test(value)) {
    throw new Error(`Invalid ${name} "${value}". Expected ${name === "countryCode" ? "two" : "three"} uppercase letters.`);
  }
  return value;
}
