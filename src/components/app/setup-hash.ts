/** Setup is open while the URL hash is #setup, so Back returns to the landing. */
export const SETUP_HASH = "#setup";

export function setupHashPresent(): boolean {
  return typeof window !== "undefined" && window.location.hash === SETUP_HASH;
}

/**
 * Opens setup on the home page as a new history entry, so Back returns to the
 * landing. Through history.pushState rather than location.hash: Next's router
 * tracks pushState, so a router refresh (a dev hot reload) keeps the hash.
 */
export function pushSetupHash(): void {
  window.history.pushState(null, "", SETUP_HASH);
}

export function clearSetupHash(): void {
  if (window.location.hash === SETUP_HASH) {
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }
}

/**
 * Re-run setup from inside the app ("Update prices" in chat, "Open catalog
 * setup" in Settings). The caller resets `onboarded` first; the hash makes
 * HomeClient show the wizard instead of the first-visit landing. From another
 * page (/settings) it navigates home.
 */
export function openSetup(): void {
  if (window.location.pathname === "/") pushSetupHash();
  else window.location.assign(`/${SETUP_HASH}`);
}
