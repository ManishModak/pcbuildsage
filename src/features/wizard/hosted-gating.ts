import type { PingResult } from "@/types/client";

const HOSTED_BYOK_PROVIDERS = ["gemini", "groq", "openrouter"] as const;
export type HostedByokProvider = (typeof HOSTED_BYOK_PROVIDERS)[number];

/** Narrow a chat-chain provider to the BYOK providers offered in hosted mode. */
export function isHostedByokProvider(provider: string): provider is HostedByokProvider {
  return (HOSTED_BYOK_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * Hosted onboarding may advance past the BYOK step only when the chosen
 * model passed the same probe local mode uses: reachable AND tool-capable.
 */
export function hostedByokCanAdvance(probe: PingResult | null | undefined): boolean {
  return Boolean(probe?.reachable && probe?.toolCapable);
}

/** Whether the probe result still describes the currently selected provider/model. */
export function hostedProbeIsCurrent(
  probe: PingResult | null | undefined,
  probedFor: { provider: string; model: string } | null,
  current: { provider: string; model: string } | null
): boolean {
  if (!probe || !probedFor || !current) return false;
  return probedFor.provider === current.provider && probedFor.model === current.model;
}

/** Skip the market step when there is nothing to choose (single market). */
export function shouldSkipMarketStep(markets: unknown): boolean {
  return Array.isArray(markets) && markets.length === 1;
}
