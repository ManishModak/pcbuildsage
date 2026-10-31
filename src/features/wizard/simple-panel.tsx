"use client";

import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { RuneText } from "@/components/app/rune-text";
import { Button } from "@/components/ui/primitives";

/**
 * Opening block shared by the onboarding steps: the step title (arriving as
 * runes) and one plain sentence under it. Keyed on the title so a new title
 * in the same slot plays the rune animation again.
 */
export function StepHeader({ title, children }: { title: string; children: ReactNode }) {
  return (
    <header className="flex flex-col gap-2">
      <h1 className="type-title text-2xl text-text">
        <RuneText key={title} text={title} />
      </h1>
      <p className="text-base text-text-secondary">{children}</p>
    </header>
  );
}

/** A step with nothing to configure: a title, one sentence and Back/Continue. */
export function SimplePanel({
  title,
  description,
  onBack,
  onNext
}: {
  title: string;
  description: string;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <section className="flex flex-col gap-6">
      <StepHeader title={title}>{description}</StepHeader>
      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="ghost" iconLeft={ArrowLeft} onClick={onBack}>
          Back
        </Button>
        <Button iconRight={ArrowRight} onClick={onNext}>
          Continue
        </Button>
      </div>
    </section>
  );
}
