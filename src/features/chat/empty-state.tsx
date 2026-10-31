import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { AsciiOwl } from "@/components/app/ascii-owl";
import { RuneText } from "@/components/app/rune-text";
import { Icon } from "@/components/ui/icon";
import { formatStarterBudget } from "@/lib/format";
import { SampleConversation } from "./sample-conversation";

// A new chat: what to type, a few ready prompts to start from, and a read-only
// example build. Empty states say what to do next, not just "No messages".
// Chat-view draws the birds behind it; none fly once a conversation starts.
export function ChatEmptyState({
  onPick,
  currency = "INR"
}: {
  onPick: (prompt: string) => void;
  currency?: string;
}) {
  // Local-only toggle: the example below renders from a static fixture and is
  // never sent through onPick, so it can never become a saved user session.
  const [showExample, setShowExample] = useState(false);
  const prompts = [
    `1440p gaming build around ${formatStarterBudget(currency)}`,
    "Quiet compact build for a small desk, no RGB",
    "I own an RTX 4070. Build the rest around it",
    "Check this build: 7800X3D, B650, 32GB DDR5, 650W"
  ];
  return (
    <div className="flex flex-col items-start gap-6 pt-12 pb-6 sm:pt-16">
      <AsciiOwl />
      <div className="flex flex-col gap-2">
        <h1 className="type-display text-[clamp(2rem,4vw,2.75rem)] text-text">
          <RuneText text="What are we building?" />
        </h1>
        <p className="max-w-[34rem] text-base leading-relaxed text-text-secondary">
          Tell the sage what the PC is for, your budget and any parts you already own. Compatibility is checked by
          rules the AI can&apos;t override, and every part comes with a buy link.
        </p>
      </div>

      <div className="w-full">
        <h2 className="type-label text-caption text-text-muted">Start from one of these</h2>
        <ul className="mt-2 divide-y divide-border border-y border-border">
          {prompts.map((prompt) => (
            <li key={prompt}>
              <button
                type="button"
                onClick={() => onPick(prompt)}
                className="group flex min-h-12 w-full cursor-pointer items-center justify-between gap-3 py-3 text-left text-[15px] text-text-secondary transition-colors duration-150 hover:text-text"
              >
                <span>{prompt}</span>
                <Icon
                  icon={ArrowRight}
                  size={16}
                  className="shrink-0 text-text-muted transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-accent"
                />
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="w-full">
        <button
          type="button"
          onClick={() => setShowExample((visible) => !visible)}
          aria-expanded={showExample}
          className="cursor-pointer text-sm font-medium text-accent hover:underline"
        >
          {showExample ? "Hide the example build" : "See an example build first"}
        </button>
        {showExample ? <SampleConversation currency={currency} className="mt-3" /> : null}
      </div>
    </div>
  );
}
