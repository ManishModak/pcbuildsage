/**
 * Web search providers the research step can use. Client-safe, shared by the
 * server's config parsing and the settings UI.
 */
export const SEARCH_PROVIDER_IDS = ["exa", "tavily", "brave", "searxng", "gemini-native", "none"] as const;

export type SearchProvider = (typeof SEARCH_PROVIDER_IDS)[number];

export function isSearchProvider(value: unknown): value is SearchProvider {
  return typeof value === "string" && (SEARCH_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Maps a saved or env value to a provider we still support. DuckDuckGo was
 * removed (its HTML endpoint disallows automated queries), so configs saved
 * with it read as "none". Other values pass through for zod to reject.
 */
export function normalizeSearchProvider(value: unknown): unknown {
  return value === "duckduckgo" ? "none" : value;
}
