"use client";

import { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { AsciiOwl } from "@/components/app/ascii-owl";
import { Icon } from "@/components/ui/icon";

export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log unexpected runtime errors to console
    console.error("Unhandled App Router Error:", error);
  }, [error]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg p-6 text-text">
      <div className="flex w-full max-w-xl flex-col items-start gap-6 sm:flex-row sm:items-center sm:gap-8">
        <AsciiOwl />
        <div className="flex min-w-0 flex-col items-start gap-4">
          <div className="flex flex-col gap-1.5">
            <h1 className="type-title text-2xl text-text">Something went wrong</h1>
            <p className="text-base leading-[1.65] text-text-secondary">
              This page hit an unexpected error. Try again, and if it keeps happening, reload the tab.
            </p>
          </div>

          {error.message && (
            <pre className="max-h-32 w-full overflow-auto rounded-card border border-border bg-surface-raised p-3 text-left font-mono text-caption text-text-secondary">
              {error.message}
            </pre>
          )}

          <button
            type="button"
            onClick={() => reset()}
            className="inline-flex min-h-11 items-center gap-2 rounded-btn bg-accent px-4 text-sm font-semibold text-on-accent transition-colors duration-150 hover:opacity-90"
          >
            <Icon icon={RefreshCw} size={16} />
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
