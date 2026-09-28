/**
 * src/lib/analytics/client.ts
 *
 * Tiny browser helper for the two client-counted events (landing_view,
 * onboarding_completed). G1/G3 own the landing + onboarding call sites and
 * can call `recordClientEvent` in M2; this module wires NO calls itself.
 * Failures are always swallowed so metrics can never break the UI.
 */

import { CLIENT_ANALYTICS_EVENTS, type ClientAnalyticsEvent } from "./events";

export { CLIENT_ANALYTICS_EVENTS };
export type { ClientAnalyticsEvent };

export async function recordClientEvent(event: ClientAnalyticsEvent): Promise<void> {
  try {
    if (!(CLIENT_ANALYTICS_EVENTS as readonly string[]).includes(event)) return;
    if (typeof fetch === "undefined") return;
    await fetch("/api/metrics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event }),
      keepalive: true
    });
  } catch {
    // Never break the UI for analytics.
  }
}
