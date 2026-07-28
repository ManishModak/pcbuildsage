"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, MessageSquare } from "lucide-react";
import { useApp } from "../app/app-provider";
import { fetchPersonalities } from "../lib/api";
import type { Personality } from "../lib/types";
import { cn } from "../ui/cn";
import { Button } from "../ui/primitives";

export function StepChat({ onBack, onFinish }: { onBack: () => void; onFinish: () => void }) {
  const { config, updateConfig } = useApp();
  const [personalities, setPersonalities] = useState<Personality[]>([]);

  useEffect(() => {
    fetchPersonalities().then(setPersonalities).catch(() => setPersonalities([]));
  }, []);

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-text">Personalize the sage</h1>
        <p className="text-base text-text-secondary">
          Pick the tone the sage speaks in. Change it any time.
        </p>
      </header>

      <div className="flex flex-col gap-3">
        <h2 className="text-caption font-medium uppercase tracking-wide text-text-secondary">Personality</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {personalities.map((personality) => {
            const active = config.personality === personality.id;
            return (
              <button
                key={personality.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => updateConfig({ personality: personality.id })}
                className={cn(
                  "flex flex-col gap-0.5 rounded-card border bg-surface p-3 text-left transition-colors duration-150",
                  active ? "border-accent" : "border-border hover:border-text-muted"
                )}
              >
                <span className="text-sm font-medium text-text">{personality.name}</span>
                <span className="text-caption text-text-secondary">{personality.description}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="ghost" iconLeft={ArrowLeft} onClick={onBack}>
          Back
        </Button>
        <Button iconRight={MessageSquare} onClick={onFinish}>
          Start building
        </Button>
      </div>
    </section>
  );
}
