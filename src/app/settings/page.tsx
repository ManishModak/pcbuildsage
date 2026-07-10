"use client";

import { useApp } from "../../components/app/app-provider";
import { AppShell } from "../../components/app/app-shell";
import { SettingsView } from "../../components/settings/settings-view";
import { Spinner } from "../../components/ui/primitives";

export default function SettingsPage() {
  const { ready } = useApp();

  if (!ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg">
        <Spinner size={32} />
      </div>
    );
  }

  return (
    <AppShell showSettings={false}>
      <SettingsView />
    </AppShell>
  );
}
