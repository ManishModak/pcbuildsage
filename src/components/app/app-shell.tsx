"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Settings } from "lucide-react";
import { IconButton } from "../ui/primitives";
import { LeafMark, Wordmark } from "./brand";
import { ThemeSwitcher } from "./theme-switcher";

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

  if (sidebar) {
    return (
      // w-full so this fills the SidebarProvider flex wrapper it now lives in;
      // without it the shell shrinks to content and the main pane collapses.
      <div className="flex min-h-dvh w-full bg-bg">
        {sidebar}
        <div className="flex flex-1 flex-col min-w-0">
          <header className="sticky top-0 z-30 border-b border-border bg-bg/95 backdrop-blur-sm">
            {/* Minimal bar: sidebar toggle (only when collapsed/mobile) + the
                page's context. Theme and Settings now live in the sidebar footer. */}
            <div className="flex h-14 w-full items-center gap-3 px-4">
              {actions}
              {headerSuffix}
            </div>
          </header>
          <main className="flex-1">{children}</main>
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
              <Link href="/settings" aria-label="Settings">
                <IconButton icon={Settings} label="Settings" />
              </Link>
            ) : null}
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
