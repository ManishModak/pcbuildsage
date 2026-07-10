"use client";

import { useApp } from "../components/app/app-provider";
import { AppShell } from "../components/app/app-shell";
import { ChatWorkspace } from "../components/chat/chat-workspace";
import { Wizard } from "../components/wizard/wizard";
import { Spinner } from "../components/ui/primitives";

export default function Home() {
  const { config, ready } = useApp();

  if (!ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg">
        <Spinner size={32} />
      </div>
    );
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
