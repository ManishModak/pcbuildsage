import { getProvider, HOSTED_PROVIDER_IDS, isHostedProvider } from "./providers";

/**
 * The provider's free default model, used ONLY when discovery returned
 * nothing and the user hasn't picked one (the wizard prefers a free,
 * tool-capable model from live discovery, see pickFreeToolCapableDefault).
 * "" for paid providers: the user picks, so nothing is billed by default.
 */
export function hostedDefaultModelFor(provider: string): string {
  return getProvider(provider)?.defaultModel ?? "";
}

/**
 * The hosted provider the chat uses: the active one when it has a key,
 * otherwise the first keyed provider in display order. A provider counts only
 * when it has a model to run (picked, or its free default).
 */
export function pickHostedProvider(
  activeProvider: string | null | undefined,
  hasKey: (provider: string) => boolean,
  getModel: (provider: string) => string | undefined
): { provider: string; model: string } | null {
  // A local provider saved as active (Ollama, your own server) can't serve the demo.
  const candidates = activeProvider && isHostedProvider(activeProvider) ? [activeProvider, ...HOSTED_PROVIDER_IDS] : HOSTED_PROVIDER_IDS;
  for (const provider of candidates) {
    if (!hasKey(provider)) continue;
    const model = getModel(provider) || hostedDefaultModelFor(provider);
    if (model) return { provider, model };
  }
  return null;
}
