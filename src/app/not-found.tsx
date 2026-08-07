import Link from "next/link";
import { ArrowLeft, FileQuestion } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-bg p-6 text-center text-text">
      <div className="flex max-w-md flex-col items-center gap-4 rounded-card border border-border bg-surface p-8 shadow-lg">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/10 text-accent">
          <FileQuestion className="h-6 w-6" />
        </div>

        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold text-text">Page Not Found</h2>
          <p className="text-sm text-text-muted">
            The route or resource you are looking for does not exist.
          </p>
        </div>

        <Link
          href="/"
          className="mt-2 inline-flex items-center gap-2 rounded-btn bg-accent px-4 py-2 text-sm font-medium text-surface transition hover:opacity-90"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}
