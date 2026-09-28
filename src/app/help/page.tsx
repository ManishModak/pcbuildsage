import type { Metadata } from "next";
import Link from "next/link";
import { pageSeo } from "@/lib/seo";

export const metadata: Metadata = pageSeo(
  "/help",
  "Help — PCBuildSage",
  "In-app help for PCBuildSage: API keys, providers, and settings."
);

export default function HelpPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-text">Help</h1>
        <p className="text-sm text-text-secondary">Short guides for getting PCBuildSage running.</p>
      </div>
      <nav className="flex flex-col gap-3" aria-label="Help topics">
        <Link
          href="/help/api-key"
          className="rounded-card border border-border bg-surface p-4 transition-colors hover:border-accent"
        >
          <span className="block text-base font-semibold text-text">Get a free API key in 2 minutes</span>
          <span className="mt-0.5 block text-sm text-text-secondary">
            Gemini and OpenRouter setup steps, what a key costs, whether it is safe, and what to do when a key is
            rejected or the free limit is hit.
          </span>
        </Link>
        <Link
          href="/settings?tab=llm"
          className="rounded-card border border-border bg-surface p-4 transition-colors hover:border-accent"
        >
          <span className="block text-base font-semibold text-text">Open Settings</span>
          <span className="mt-0.5 block text-sm text-text-secondary">
            Paste or clear provider keys and pick the model chat uses.
          </span>
        </Link>
      </nav>
    </main>
  );
}
