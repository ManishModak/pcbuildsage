"use client";

import { useRef } from "react";
import { cn } from "./cn";

export type PillTab = { value: string; label: string };

// Pill tabs (999px radius) with roving arrow-key navigation.
export function PillTabs({
  tabs,
  value,
  onChange,
  ariaLabel
}: {
  tabs: PillTab[];
  value: string;
  onChange: (next: string) => void;
  ariaLabel: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = (index + delta + tabs.length) % tabs.length;
    refs.current[next]?.focus();
    onChange(tabs[next].value);
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-flex flex-wrap gap-1 rounded-pill border border-border bg-surface p-1"
    >
      {tabs.map((tab, index) => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onKeyDown={(event) => onKeyDown(event, index)}
            onClick={() => onChange(tab.value)}
            className={cn(
              "min-h-9 rounded-pill px-4 text-sm font-medium transition-colors duration-150",
              active ? "bg-accent text-on-accent" : "text-text-secondary hover:text-text"
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
