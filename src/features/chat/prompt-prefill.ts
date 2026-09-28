/**
 * `?prompt=` prefill contract: static build guides link to the demo with
 * `?prompt=<encoded request>` ("Customise this build"). The chat workspace
 * reads it once on mount into a fresh session's composer (never auto-sent),
 * then strips it from the URL so a reload does not prefill again.
 */
export const PROMPT_PARAM = "prompt";

/**
 * Upper bound on prefilled text. Guide requests name all eight parts with
 * full retailer listing names (often 80-120 chars each), so this is sized to
 * fit those while still bounding what an arbitrary link can inject.
 */
export const MAX_PREFILL_CHARS = 2000;

/** Pure read: the capped, trimmed `?prompt=` value, or "" when absent. */
export function readPromptPrefill(search: string): string {
  const raw = new URLSearchParams(search).get(PROMPT_PARAM);
  return raw === null ? "" : raw.trim().slice(0, MAX_PREFILL_CHARS);
}

/** Removes `?prompt=` from the address bar without navigating or adding history. */
export function stripPromptParam(
  win: Pick<Window, "location" | "history"> = window
): void {
  const url = new URL(win.location.href);
  if (!url.searchParams.has(PROMPT_PARAM)) return;
  url.searchParams.delete(PROMPT_PARAM);
  win.history.replaceState(win.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
