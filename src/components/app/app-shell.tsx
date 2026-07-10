"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Settings } from "lucide-react";
import { IconButton } from "../ui/primitives";
import { LeafMark, Wordmark } from "./brand";
import { ThemeSwitcher } from "./theme-switcher";

export function AppShell({
  children,
  actions,
  showSettings = true
}: {
  children: ReactNode;
  actions?: ReactNode;
  showSettings?: boolean;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="sticky top-0 z-30 border-b border-border bg-bg/95 backdrop-blur-sm">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-4">
          <Link href="/" className="flex items-center gap-2 rounded-btn" aria-label="PCBuildSage home">
            <LeafMark size={22} />
            <Wordmark className="text-base" />
          </Link>
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
