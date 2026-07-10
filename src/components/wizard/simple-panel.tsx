"use client";

import { ArrowLeft, ArrowRight, Database } from "lucide-react";
import { Icon } from "../ui/icon";
import { Button } from "../ui/primitives";

export function SimplePanel({
  icon,
  title,
  description,
  onBack,
  onNext
}: {
  icon: typeof Database;
  title: string;
  description: string;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <section className="flex flex-col gap-6">
      <div className="flex items-start gap-4 rounded-card border border-border bg-surface p-5">
        <span className="flex h-10 w-10 items-center justify-center rounded-btn border border-border text-accent">
          <Icon icon={icon} size={20} />
        </span>
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-text">{title}</h1>
          <p className="text-sm text-text-secondary">{description}</p>
        </div>
      </div>
      <div className="flex items-center justify-between">
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
