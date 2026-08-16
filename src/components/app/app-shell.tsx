"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Settings } from "lucide-react";
import { IconButton } from "../ui/primitives";
import { LeafMark, Wordmark } from "./brand";
import { ThemeSwitcher } from "./theme-switcher";
import { SettingsDialog } from "@/features/settings/settings-dialog";

import { useApp } from "./app-provider";

export function AppShell({
  children,
  actions,
  showSettings = true,
  sidebar
}: {
  children: ReactNode;
  actions?: ReactNode;
  showSettings?: boolean;
  sidebar?: ReactNode;
}) {
  const { headerSuffix } = useApp();
  const [settingsOpen, setSettingsOpen] = useState(false);

  if (sidebar) {
    return (
      // w-full so this fills the SidebarProvider flex wrapper it now lives in;
      // h-dvh and overflow-hidden prevent the outer viewport from scrolling so
      // chat messages and side panels scroll independently in their own containers.
      <div className="flex h-dvh w-full bg-bg overflow-hidden">
        {sidebar}
        <div className="flex flex-1 flex-col min-w-0 h-full overflow-hidden">
          <header className="shrink-0 border-b border-border bg-bg/95 backdrop-blur-sm z-30">
            {/* Minimal bar: sidebar toggle (only when collapsed/mobile) + the
                page's context. Theme and Settings now live in the sidebar footer. */}
            <div className="flex h-14 w-full items-center gap-3 px-4">
              {actions}
              {headerSuffix}
            </div>
          </header>
          <main className="flex flex-1 min-h-0 min-w-0 overflow-hidden">{children}</main>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="sticky top-0 z-30 border-b border-border bg-bg/95 backdrop-blur-sm">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-4">
          <Link href="/" className="flex items-center gap-2 rounded-btn" aria-label="PCBuildSage home">
            <LeafMark size={22} />
            <Wordmark className="text-base" />
          </Link>
          {headerSuffix}
          <div className="ml-auto flex items-center gap-1">
            {actions}
            <ThemeSwitcher />
            {showSettings ? (
              <IconButton
                icon={Settings}
                label="Settings"
                onClick={() => setSettingsOpen(true)}
              />
            ) : null}
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
