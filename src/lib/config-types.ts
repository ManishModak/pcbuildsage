export type LLMProvider = "gemini" | "ollama" | "openrouter" | "openai-compatible";
export type LLMRole = "chat" | "subagent" | "scraper";
export type KeySource = "env" | "ui" | "none";
export type SearchProvider = "exa" | "tavily" | "brave" | "searxng" | "duckduckgo" | "gemini-native" | "none";

export type LLMChainEntry = {
  provider: LLMProvider;
  model: string;
  keySource: KeySource;
  apiKey?: string;
  baseUrl?: string;
};

export type ProviderConfig = {
  provider: LLMProvider;
  apiKey?: string;
  baseUrl?: string;
  keySource: KeySource;
};

export type RoleChains = Record<LLMRole, LLMChainEntry[]>;

export type AppConfig = {
  dbPath: string;
  activeProfile?: string;
  countryCode: string;
  currency: string;
  persona: string;
  /** Optional multi-select personas; when set, takes precedence over `persona`. */
  personas?: string[];
  personality: string;
  theme: string;
  tier2Enabled: boolean;
  freeformConsultEnabled: boolean;
  llm: {
    chain: LLMChainEntry[];
    roles: RoleChains;
  };
  search: {
    provider: SearchProvider;
    baseUrl?: string;
    apiKey?: string;
  };
};

export type ConfigInput = Partial<
  Omit<AppConfig, "llm" | "search"> & {
    llmChain: string | LLMChainEntry[];
    chatLlmChain: string | LLMChainEntry[];
    subagentLlmChain: string | LLMChainEntry[];
    scraperLlmChain: string | LLMChainEntry[];
    searchProvider: SearchProvider;
    searchBaseUrl: string;
    searchApiKey: string;
  }
>;
