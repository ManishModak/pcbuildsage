"use client";

import { useEffect } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";

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
    <div className="flex min-h-dvh flex-col items-center justify-center bg-bg p-6 text-center text-text">
      <div className="flex max-w-md flex-col items-center gap-4 rounded-card border border-border bg-surface p-8 shadow-lg">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-warn/10 text-warn">
          <TriangleAlert className="h-6 w-6" />
        </div>

        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold text-text">Something went wrong</h2>
          <p className="text-sm text-text-muted">
            An unexpected application error occurred. You can attempt to reset the current view.
          </p>
        </div>

        {error.message && (
          <pre className="max-h-32 w-full overflow-auto rounded bg-bg p-3 text-left font-mono text-xs text-text-muted">
            {error.message}
          </pre>
        )}

        <button
          type="button"
          onClick={() => reset()}
          className="mt-2 inline-flex items-center gap-2 rounded-btn bg-accent px-4 py-2 text-sm font-medium text-surface transition hover:opacity-90"
        >
          <RefreshCw className="h-4 w-4" />
          Try Again
        </button>
      </div>
    </div>
  );
}
