import { useState } from "react";
import { LeafMark } from "@/components/app/brand";
import { formatStarterBudget } from "@/lib/format";
import { SampleConversation } from "./sample-conversation";

// Empty states teach: say what to do next, not just "No messages".
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
  const budgetPrompt = `Best 1440p gaming build around ${formatStarterBudget(currency)}`;
  const prompts = [
    budgetPrompt,
    "Quiet compact build for a small desk, no RGB",
    "I own an RTX 4070 — build the rest around it",
    "Roast this build: 7800X3D, B650, 32GB DDR5, 650W"
  ];
  return (
    <div className="flex flex-col items-center gap-5 py-16 text-center">
      <LeafMark size={40} />
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold text-text">What are we building?</h1>
        <p className="mx-auto max-w-md text-base text-text-secondary">
          Tell the sage your goal, budget, and any parts you already own. Every recommendation is checked
          against a deterministic compatibility engine before it reaches you.
        </p>
      </div>
      <div className="mt-2 grid w-full max-w-lg gap-2 sm:grid-cols-2">
        {prompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onPick(prompt)}
            className="rounded-card border border-border bg-surface px-4 py-3 text-left text-sm text-text-secondary transition-colors duration-150 hover:border-accent hover:text-text cursor-pointer"
          >
            {prompt}
          </button>
        ))}
      </div>
      <div className="w-full max-w-lg">
        <button
          type="button"
          onClick={() => setShowExample((visible) => !visible)}
          aria-expanded={showExample}
          className="text-sm font-medium text-accent hover:underline cursor-pointer"
        >
          {showExample ? "Hide example build" : "See an example build"}
        </button>
        {showExample ? <SampleConversation currency={currency} /> : null}
      </div>
    </div>
  );
}

