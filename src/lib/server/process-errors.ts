/**
 * src/lib/server/process-errors.ts
 *
 * Shared process-error classification and user-facing crawler messaging.
 * Deliberately lower-level than python-process and web-search: both import
 * from here, never the reverse.
 */

/**
 * Narrow missing-browser detection. Only executable/install evidence counts -
 * a message merely mentioning Chromium may be a crash, timeout, or launch
 * failure, and must not be reported as a missing browser.
 */
export function isMissingBrowserError(text: string | undefined): boolean {
  if (!text) return false;
  return (
    text.includes("Executable doesn") ||
    text.includes("playwright install")
  );
}

/**
 * Single user-facing message for unavailable page crawling. Shared so the
 * search client, subagent tools, and UI copy cannot drift apart.
 */
export function crawlUnavailableMessage(reason?: string): string {
  return `Page crawling unavailable: ${reason ?? "Chromium is missing"}. Web search is available.`;
}
