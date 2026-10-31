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
    <main className="mx-auto flex w-full max-w-[68ch] flex-col gap-8 px-6 py-12">
      <div className="flex flex-col gap-2">
        <h1 className="type-title text-2xl text-text">Help</h1>
        <p className="text-base leading-[1.65] text-text-secondary">Short guides for getting PCBuildSage running.</p>
      </div>
      <nav aria-label="Help topics">
        <ul className="divide-y divide-border overflow-hidden rounded-card border border-border">
          <li>
            <Link
              href="/help/api-key"
              className="block px-4 py-4 transition-colors duration-150 hover:bg-surface-raised"
            >
              <span className="type-title block text-base text-text">Get a free API key in 2 minutes</span>
              <span className="mt-1 block text-sm leading-relaxed text-text-secondary">
                Gemini and OpenRouter setup steps, what a key costs, whether it is safe, and what to do when a key is
                rejected or the free limit is hit.
              </span>
            </Link>
          </li>
          <li>
            <Link
              href="/settings?tab=llm"
              className="block px-4 py-4 transition-colors duration-150 hover:bg-surface-raised"
            >
              <span className="type-title block text-base text-text">Open settings</span>
              <span className="mt-1 block text-sm leading-relaxed text-text-secondary">
                Paste or clear provider keys and pick the model chat uses.
              </span>
            </Link>
          </li>
        </ul>
      </nav>
    </main>
  );
}
