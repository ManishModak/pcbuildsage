"use client";

import type { ReactNode } from "react";
import { useApp } from "@/components/app/app-provider";
import { AppShell } from "@/components/app/app-shell";
import { ChatWorkspace } from "@/features/chat/chat-workspace";
import { Wizard } from "@/features/wizard/wizard";

// G4-ANALYTICS PLACEHOLDER: if a future "landing view" client event is ever
// added, fire it from this component (e.g. when `ready` is false and the
// server-rendered landing is on screen). G1 implements no tracking of any
// kind: no cookies, no IDs, no beacons.
export function HomeClient({ landing }: { landing: ReactNode }) {
  const { config, ready } = useApp();

  // Not yet hydrated from localStorage: keep the server-rendered landing
  // visible so crawlers and first paint see real content instead of a spinner.
  if (!ready) {
    return <>{landing}</>;
  }

  if (!config.onboarded) {
    return (
      <AppShell showSettings={false}>
        <Wizard onComplete={() => {}} />
      </AppShell>
    );
  }

  return <ChatWorkspace config={config} />;
}
