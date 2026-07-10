// Client-side mirrors of the API response shapes consumed by the UI.
// These intentionally duplicate only the fields the frontend renders.

export type LLMProvider = "gemini" | "ollama" | "openrouter" | "openai-compatible";
export type KeySource = "env" | "ui" | "none";

export type ChainEntry = {
  id: string;
  provider: LLMProvider;
  model: string;
  baseUrl?: string;
  keySource: KeySource;
  /** Present only for keySource "ui"; never rendered back into an input. */
  hasSavedKey?: boolean;
  presetName?: string;
  ping?: PingResult;
};

export type PingResult = {
  reachable: boolean;
  latencyMs: number;
  toolCapable: boolean;
  hint?: string;
};

export type ClientConfig = {
  onboarded: boolean;
  theme: string;
  countryCode: string;
  currency: string;
  personality: string;
  personas: string[];
  tier2Enabled: boolean;
  auditVisible: boolean;
  freeformConsultEnabled: boolean;
  chatChain: ChainEntry[];
  subagentChain: ChainEntry[] | null;
};

export type StatusResponse = {
  database: { path: string; exists: boolean; rowCounts: Array<{ countryCode: string; count: number }> };
  python: { ok: boolean; command?: string; args: string[]; label?: string; error?: string };
};

export type CredentialAvailability = {
  llm: Record<string, boolean>;
  search: Record<string, boolean>;
};

export type ProfileSummary = {
  id: string;
  profileName?: string;
  countryCode?: string;
  flag?: string;
  currency?: string;
  siteCount: number;
  sites: Array<{ name?: string; categories: string[] }>;
  lastValidated: string;
};

export type ThemeFile = {
  id: string;
  theme_name?: string;
  mode?: "dark" | "light";
  tokens: Record<string, string>;
};

export type Persona = {
  id: string;
  persona_name: string;
  description: string;
  priorities: string[];
  tone: string;
  budget_weights: Record<string, number>;
};

export type Personality = {
  id: string;
  name: string;
  description: string;
  prompt: string;
};

export type EndpointPreset = {
  name: string;
  base_url: string;
  default_port?: number;
  requires_key: boolean;
  model_list_style: "openai" | "ollama";
  tool_support_notes?: string;
  launch_flags?: string;
};

export type DiscoveredModel = { id: string; name?: string };

export type ScrapeEvent =
  | { type: "started"; id?: string }
  | { type: "site_started"; site: string; category?: string }
  | {
      type: "progress";
      site: string;
      category?: string;
      percent?: number;
      page?: number;
      pages_total?: number;
      products_seen?: number;
      skipped?: boolean;
    }
  | { type: "site_failed"; site: string; category?: string; error: string }
  | { type: "done"; products_written?: number }
  | { type: "log"; stream: string; message: string }
  | { type: "exit"; code?: number | null; signal?: string | null }
  | { type: "error"; error: string };

export type ScrapeRunConfig = {
  profile: string;
  sites?: string[];
  categories?: string[];
  quick?: boolean;
  maxPages?: number;
  skipFresh?: number;
  noLlmFallback?: boolean;
  maxLlmCalls?: number;
  concurrency?: number;
  delayMs?: number;
  headed?: boolean;
  db?: string;
};

// Validation result mirrored from src/lib/rules-engine.
export type IssueSeverity = "blocking" | "needs_research" | "needs_verification";
export type BuildIssue = {
  severity: IssueSeverity;
  rule: string;
  components: string[];
  detail: string;
};
export type ValidationResult = {
  valid: boolean;
  issues: BuildIssue[];
  resolved: Record<string, unknown>;
};

// search_products tool output rows.
export type ProductRow = {
  id: string;
  name: string;
  category: string;
  price_minor: number | null;
  currency: string;
  country_code: string;
  retailer: string;
  url: string;
  in_stock: boolean;
  registry_key?: string | null;
  specs?: Record<string, unknown> | null;
};

export type ChatMetadata = { provider: string; model: string; fallbackIndex: number };
