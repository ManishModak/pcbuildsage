"use client";

import type { ReactNode } from "react";
import { RuneText } from "@/components/app/rune-text";

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
