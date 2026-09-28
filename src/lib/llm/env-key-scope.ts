import type { LLMChainEntry, LLMProvider } from "@/types";

// Cloud providers with one official API host. Their .env key is only sent
// there, so a request that sets its own baseUrl can't redirect the key to
// another server. Gemini isn't listed: its client and discovery always call
// Google's host and ignore baseUrl.
const ENV_KEY_HOSTS: Partial<Record<LLMProvider, string>> = {
  openrouter: "openrouter.ai",
  groq: "api.groq.com"
};

/** Whether this entry's endpoint may receive the server's .env key for its provider. */
export function envKeyAllowed(entry: Pick<LLMChainEntry, "provider" | "baseUrl">): boolean {
  const officialHost = ENV_KEY_HOSTS[entry.provider];
  const baseUrl = entry.baseUrl?.trim();
  if (!officialHost || !baseUrl) return true;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === officialHost;
  } catch {
    return false;
  }
}
