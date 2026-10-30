"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/app/app-provider";
import { AppShell } from "@/components/app/app-shell";
import { LandingActionsContext } from "@/components/app/landing-actions";
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

/** Setup is open while the URL hash is #setup, so Back returns to the landing. */
const SETUP_HASH = "#setup";

function setupHashPresent(): boolean {
  return typeof window !== "undefined" && window.location.hash === SETUP_HASH;
}

function clearSetupHash(): void {
  if (window.location.hash === SETUP_HASH) {
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }
}

export function HomeClient({ landing }: { landing: ReactNode }) {
  const { config, ready } = useApp();
  const [setupOpen, setSetupOpen] = useState(setupHashPresent);

  useEffect(() => {
    if (landingViewDue(ready, config.onboarded)) fireOnce("landing_view");
  }, [ready, config.onboarded]);

  useEffect(() => {
    const sync = () => setSetupOpen(setupHashPresent());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const startSetup = useCallback(() => {
    window.location.hash = SETUP_HASH;
    setSetupOpen(true);
    window.scrollTo(0, 0);
  }, []);
  const landingActions = useMemo(() => ({ startSetup }), [startSetup]);

  // First-time visitors get the landing (the same HTML the server rendered, so
  // nothing flashes or swaps) until they choose to set up. Before hydration
  // the landing stays for crawlers and first paint; returning users get the
  // spinner instead (CSS keyed on html[data-returning], see layout.tsx). The
  // tree shape is the same in both states so the landing never remounts.
  if (!ready || (!config.onboarded && !setupOpen)) {
    return (
      <LandingActionsContext.Provider value={landingActions}>
        <div data-landing="">{landing}</div>
        {!ready ? (
          <div data-returning-spinner="" className="min-h-dvh items-center justify-center bg-bg">
            <Spinner size={32} />
          </div>
        ) : null}
      </LandingActionsContext.Provider>
    );
  }

  if (!config.onboarded) {
    return (
      <AppShell showSettings={false}>
        <Wizard
          onComplete={() => {
            clearSetupHash();
            fireOnce("onboarding_completed");
          }}
          onExit={() => {
            clearSetupHash();
            setSetupOpen(false);
          }}
        />
      </AppShell>
    );
  }

  return <ChatWorkspace config={config} />;
}
