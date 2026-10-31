/**
 * Last-resort hosted model IDs. These are used ONLY when discovery returned
 * nothing and the user has not picked a model yet — the wizard always prefers
 * a free, tool-capable model from live discovery (see pickFreeToolCapableDefault)
 * and otherwise asks the user to pick. Keep this list free-tier.
 */
export const HOSTED_LAST_RESORT_MODEL = "meta-llama/llama-3.3-70b-instruct:free";

/** Non-paid per-provider fallbacks used only when no discovered model or user pick exists. */
export function hostedDefaultModelFor(provider: string): string {
  if (provider === "gemini") return "gemini-2.5-flash";
  if (provider === "groq") return "llama-3.3-70b-versatile";
  return HOSTED_LAST_RESORT_MODEL;
}
