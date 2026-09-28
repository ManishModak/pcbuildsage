"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { useApp } from "@/components/app/app-provider";
import { AppShell } from "@/components/app/app-shell";
import { ChatWorkspace } from "@/features/chat/chat-workspace";
import { Wizard } from "@/features/wizard/wizard";
import { recordClientEvent } from "@/lib/analytics/client";

// M2 analytics (G4): two anonymous client events, both POSTed to /api/metrics
// (allow-listed, rate-limited, hosted-only no-op in local mode, failures
// swallowed). landing_view fires once per page load while the landing is on
// screen; onboarding_completed fires when the Wizard finishes successfully.
const firedEvents = new Set<string>();

function fireOnce(event: "landing_view" | "onboarding_completed"): void {
  if (firedEvents.has(event)) return;
  firedEvents.add(event);
  void recordClientEvent(event);
}

/** Test hook: lets vitest assert one-shot wiring without reloading the module. */
export function resetHomeClientEventsForTesting(): void {
  firedEvents.clear();
}
export function HomeClient({ landing }: { landing: ReactNode }) {
  const { config, ready } = useApp();

  // Landing is on screen until hydration resolves the saved config: count the
  // view once. Returning users briefly see it too during hydration; the event
  // is defined as "landing HTML viewed", i.e. effectively a page view.
  useEffect(() => {
    if (!ready) fireOnce("landing_view");
  }, [ready]);

  // Not yet hydrated from localStorage: keep the server-rendered landing
  // visible so crawlers and first paint see real content instead of a spinner.
  if (!ready) {
    return <>{landing}</>;
  }

  if (!config.onboarded) {
    return (
      <AppShell showSettings={false}>
        <Wizard onComplete={() => fireOnce("onboarding_completed")} />
      </AppShell>
    );
  }

  return <ChatWorkspace config={config} />;
}
