// Client-side mirrors of the API response shapes consumed by the UI.
// These intentionally duplicate only the fields the frontend renders.

import type { KeySource, LLMProvider, ReasoningEffort, SearchProvider } from "./config";
import type { RunOutcome } from "@/contracts/scrape";

export type ChainEntry = {
  id: string;
  provider: LLMProvider;
  model: string;
  baseUrl?: string;
  keySource: KeySource;
  reasoningEffort?: ReasoningEffort;
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

export type { KeySource, LLMProvider, ReasoningEffort, SearchProvider };

export type ClientConfig = {
  onboarded: boolean;
  theme: string;
  countryCode: string;
  currency: string;
  personality: string;
  tier2Enabled: boolean;
  auditVisible: boolean;
  freeformConsultEnabled: boolean;
  chatChain: ChainEntry[];
  subagentChain: ChainEntry[] | null;
  searchProvider: SearchProvider;
  searchBaseUrl?: string;
  crawlEnabled: boolean;
};

export type MarketMetadata = {
  code: string;
  name: string;
  defaultCurrency: string;
  supportedCurrencies: string[];
  locale: string;
};

export type StatusResponse = {
  status?: string;
  mode?: "local" | "hosted-demo";
  deploymentMode?: "local" | "hosted-demo";
  catalogFreshness?: string | null;
  productCount?: number;
  database: {
    path?: string;
    exists: boolean;
    rowCounts: Array<{ countryCode: string; count: number; lastScraped?: string | null }>;
    lastScraped?: string | null;
  };
  python?: { ok: boolean; command?: string; args: string[]; label?: string; error?: string };
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
  | { type: "outcome"; outcome: RunOutcome }
  | { type: "log"; stream: string; message: string }
  | { type: "exit"; code?: number | null; signal?: string | null }
  | { type: "error"; error: string };

export type { ScrapeRunConfig } from "@/contracts/scrape";

// Validation result mirrored from src/lib/rules-engine.
export type IssueSeverity = "blocking" | "needs_research" | "needs_verification" | "advisory";
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
  price: number | null;
  currency: string;
  country_code: string;
  retailer: string;
  url: string;
  in_stock: boolean;
  registry_key?: string | null;
  specs?: Record<string, unknown> | null;
};

export type ChatMetadata = { provider: string; model: string; fallbackIndex: number; primaryError?: string };

// Chat session history (persisted conversations). Summaries are the light
// list shape (no messages blob); the full record's messages are typed as
// ChatUIMessage[] where they are consumed (see api.ts / chat-sidebar).
export type SessionSummary = {
  id: string;
  title: string | null;
  created_at: Date;
  updated_at: Date;
};
