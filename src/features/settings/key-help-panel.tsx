"use client";

import Link from "next/link";
import { KeyRound } from "lucide-react";
import { API_KEY_GUIDES } from "@/content/api-key-help";
import { Card } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/icon";

/**
 * Concise "get a free key in 2 minutes" panel rendered beside the BYOK
 * section. Read-only: it never touches key save/clear/model logic — those
 * stay entirely in byok-section.tsx / byok-provider-card.tsx. Full guide
 * lives at /help/api-key; all copy comes from the shared content module.
 */
export function KeyHelpPanel() {
  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="key-help-panel">
      <div className="flex items-center gap-2">
        <Icon icon={KeyRound} size={16} className="text-accent" />
        <h3 className="text-sm font-semibold text-text">Get a free key in 2 minutes</h3>
      </div>
      <ol className="flex flex-col gap-2.5">
        {API_KEY_GUIDES.map((guide, index) => (
          <li key={guide.id} className="flex flex-col gap-0.5 text-sm text-text-secondary">
            <span className="font-medium text-text">
              {index + 1}. {guide.provider} (free)
            </span>
            <span className="leading-relaxed">
              {guide.steps[0].text}{" "}
              <a
                href={guide.keyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-accent hover:underline"
              >
                {guide.keyUrlLabel} ↗
              </a>{" "}
              {guide.steps[2].text}
            </span>
          </li>
        ))}
      </ol>
      <Link href="/help/api-key" className="text-sm font-medium text-accent hover:underline" data-testid="key-help-full-guide-link">
        Full step-by-step guide with costs and safety notes →
      </Link>
    </Card>
  );
}
