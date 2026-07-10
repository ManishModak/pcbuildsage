import type { ChainEntry, ClientConfig, ScrapeRunConfig } from "./types";

const CONFIG_KEY = "pcbuildsage:config";
const SCRAPE_KEY = "pcbuildsage:lastScrape";
const KEYS_KEY = "pcbuildsage:uiKeys";

export const DEFAULT_CONFIG: ClientConfig = {
  onboarded: false,
  theme: "sage-dark",
  countryCode: "IN",
  currency: "INR",
  personality: "helpful-consultant",
  personas: ["frame-chaser", "balanced-showpiece", "upgrade-path"],
  tier2Enabled: true,
  auditVisible: true,
  freeformConsultEnabled: false,
  chatChain: [],
  subagentChain: null
};

export function validateConfig(parsed: unknown): ClientConfig {
  const config = { ...DEFAULT_CONFIG };
  if (!parsed || typeof parsed !== "object") return config;

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.onboarded === "boolean") config.onboarded = obj.onboarded;
  if (typeof obj.theme === "string") config.theme = obj.theme;
  if (typeof obj.countryCode === "string") config.countryCode = obj.countryCode;
  if (typeof obj.currency === "string") config.currency = obj.currency;
  if (typeof obj.personality === "string") config.personality = obj.personality;
  
  if (Array.isArray(obj.personas)) {
    config.personas = obj.personas.filter((p): p is string => typeof p === "string");
  }
  if (typeof obj.tier2Enabled === "boolean") config.tier2Enabled = obj.tier2Enabled;
  if (typeof obj.auditVisible === "boolean") config.auditVisible = obj.auditVisible;
  if (typeof obj.freeformConsultEnabled === "boolean") {
    config.freeformConsultEnabled = obj.freeformConsultEnabled;
  }
  
  if (Array.isArray(obj.chatChain)) {
    config.chatChain = obj.chatChain.filter((entry: unknown): entry is ChainEntry => {
      if (!entry || typeof entry !== "object") return false;
      const e = entry as Record<string, unknown>;
      return (
        typeof e.id === "string" &&
        typeof e.provider === "string" &&
        typeof e.model === "string" &&
        typeof e.keySource === "string"
      );
    });
  }

  if (Array.isArray(obj.subagentChain)) {
    config.subagentChain = obj.subagentChain.filter((entry: unknown): entry is ChainEntry => {
      if (!entry || typeof entry !== "object") return false;
      const e = entry as Record<string, unknown>;
      return (
        typeof e.id === "string" &&
        typeof e.provider === "string" &&
        typeof e.model === "string" &&
        typeof e.keySource === "string"
      );
    });
  } else {
    config.subagentChain = null;
  }

  return config;
}

export function loadConfig(): ClientConfig {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return DEFAULT_CONFIG;
    return validateConfig(JSON.parse(raw));
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: ClientConfig): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    // ignore quota / private-mode failures
  }
}

export function loadLastScrape(): Partial<ScrapeRunConfig> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SCRAPE_KEY);
    return raw ? (JSON.parse(raw) as Partial<ScrapeRunConfig>) : null;
  } catch {
    return null;
  }
}

export function saveLastScrape(config: Partial<ScrapeRunConfig>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SCRAPE_KEY, JSON.stringify(config));
  } catch {
    // ignore
  }
}

// UI-entered API keys are write-only: stored so chat works across sessions, but
// never read back into any input. They travel to the server only as headers.
type KeyMap = Partial<Record<string, string>>;

export function saveUiKey(provider: string, key: string): void {
  if (typeof window === "undefined") return;
  try {
    const map = readKeyMap();
    map[provider] = key;
    localStorage.setItem(KEYS_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

export function hasUiKey(provider: string): boolean {
  return Boolean(readKeyMap()[provider]);
}

export function apiKeyHeaders(chain: ChainEntry[]): Record<string, string> {
  const map = readKeyMap();
  const headers: Record<string, string> = {};
  for (const entry of chain) {
    if (entry.keySource === "ui") {
      const key = map[entry.provider];
      if (key) headers[`x-pcbuildsage-api-key-${entry.provider}`] = key;
    }
  }
  return headers;
}

function readKeyMap(): KeyMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEYS_KEY);
    return raw ? (JSON.parse(raw) as KeyMap) : {};
  } catch {
    return {};
  }
}

/** Convert client chain entries to the server ConfigInput chain shape. */
export function toServerChain(chain: ChainEntry[]) {
  return chain.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    keySource: entry.keySource,
    baseUrl: entry.baseUrl
    // apiKey deliberately omitted: keys travel via headers, never body.
  }));
}
