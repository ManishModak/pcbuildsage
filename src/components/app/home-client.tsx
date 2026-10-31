"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { useApp } from "@/components/app/app-provider";
import { AppShell } from "@/components/app/app-shell";
import { ChatWorkspace } from "@/features/chat/chat-workspace";
import { Wizard } from "@/features/wizard/wizard";
import { Spinner } from "@/components/ui/primitives";
import { recordClientEvent } from "@/lib/analytics/client";

// M2 analytics (G4): two anonymous client events, both POSTed to /api/metrics
// (allow-listed, rate-limited, hosted-only no-op in local mode, failures
// swallowed). landing_view fires once per page load for first-time visitors
// (not onboarded); onboarding_completed fires when the Wizard finishes.
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
/** landing_view counts first-time visitors only, once the saved config is known. */
export function landingViewDue(ready: boolean, onboarded: boolean): boolean {
  return ready && !onboarded;
}

export function HomeClient({ landing }: { landing: ReactNode }) {
  const { config, ready } = useApp();

  useEffect(() => {
    if (landingViewDue(ready, config.onboarded)) fireOnce("landing_view");
  }, [ready, config.onboarded]);

  // Not yet hydrated from localStorage: keep the server-rendered landing in
  // the HTML so crawlers and first paint see real content. Returning users
  // get the spinner instead (CSS keyed on html[data-returning], see layout.tsx).
  if (!ready) {
    return (
      <>
        <div data-landing="">{landing}</div>
        <div data-returning-spinner="" className="min-h-dvh items-center justify-center bg-bg">
          <Spinner size={32} />
        </div>
      </>
    );
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
