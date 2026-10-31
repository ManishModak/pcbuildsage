"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { API_KEY_GUIDES } from "@/content/api-key-help";
import { Icon } from "@/components/ui/icon";

/**
 * Short "get a free key" steps shown above the key rows in Settings.
 * Read-only: key save/clear/model logic stays in byok-section.tsx and
 * byok-provider-card.tsx. The full guide lives at /help/api-key; all copy
 * comes from the shared content module.
 */
export function KeyHelpPanel() {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4" data-testid="key-help-panel">
      <h3 className="type-title text-base text-text">Get a free key</h3>
      <ol className="flex flex-col gap-3">
        {API_KEY_GUIDES.map((guide, index) => (
          <li key={guide.id} className="flex gap-3 text-sm text-text-secondary">
            <span className="font-mono text-caption leading-5 text-text-muted" aria-hidden>
              {index + 1}
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="font-medium text-text">{guide.provider} (free)</span>
              <span className="leading-relaxed">
                {guide.steps[0].text}{" "}
                <a
                  href={guide.keyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
                >
                  {guide.keyUrlLabel}
                  <Icon icon={ExternalLink} size={12} />
                </a>{" "}
                {guide.steps[2].text}
              </span>
            </span>
          </li>
        ))}
      </ol>
      <Link href="/help/api-key" className="self-start text-sm font-medium text-accent hover:underline" data-testid="key-help-full-guide-link">
        Read the full guide, with costs and safety notes
      </Link>
    </div>
  );
}

/**
 * What happens to a pasted API key, in plain words. Shared by the key rows
 * and the web research key so every surface says the same thing.
 */
export const KEY_HANDLING_SENTENCES = [
  "Your key is stored in this browser tab's session storage.",
  "It's sent with each request to the PCBuildSage server only so the server can forward it to the provider you chose.",
  "The server never writes it to disk, stores it in a database or logs it.",
  "You can revoke it at the provider any time."
] as const;

/** Note under the key rows, including the "Remember for this browser" exception. */
export function KeyHandlingNote({ className }: { className?: string }) {
  return (
    <div className={className}>
      <h3 className="type-label text-caption text-text-secondary">What happens to your key</h3>
      <p className="mt-1 text-caption leading-relaxed text-text-muted">
        {`${KEY_HANDLING_SENTENCES.join(" ")} `}
        If you turn on &ldquo;Remember for this browser&rdquo;, it&apos;s kept in this browser&apos;s local storage
        instead, until you clear it.
      </p>
    </div>
  );
}
