"use client";

import { useApp } from "@/components/app/app-provider";
import { SettingsView } from "@/features/settings/settings-view";
import { Spinner } from "@/components/ui/primitives";

export default function SettingsPage() {
  const { ready } = useApp();

  if (!ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg">
        <Spinner size={32} />
      </div>
    );
  }

  // SettingsView is a self-contained full-screen layout (own sidebar + header),
  // so it renders directly — wrapping it in AppShell would stack a second top bar.
  return <SettingsView />;
}
