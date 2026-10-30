"use client";

import { useMemo, useState } from "react";
import type { BuildSnapshot } from "@/lib/catalog/build-snapshot";
import type { ValidationResult } from "@/types/client";
import { PillTabs } from "@/components/ui/pill-tabs";
import { cn } from "@/components/ui/cn";
import { BuildCard } from "./build-card";
import { derivedBuildFromSnapshot } from "./build-derive";
import fixture from "../../../data/fixtures/sample-conversation.json";

interface SampleExample {
  id: string;
  label: string;
  prompt: string;
  answer: string;
  validation: ValidationResult;
  snapshot: BuildSnapshot;
}

interface SampleConversationFixture {
  version: number;
  generated_at: string;
  source: { db: string; scope: { countryCode: string; currency: string } };
  examples: SampleExample[];
}

const data = fixture as unknown as SampleConversationFixture;

/** The day the example prices were observed, e.g. "30 Oct 2026". */
function exampleDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// Read-only example builds rendered from a static catalog snapshot: the
// landing shows them to first-time visitors and the empty chat offers them.
// The fixture is imported at build time, so this makes no API calls, needs no
// key, and is never inserted into the chat transcript or saved as a user
// session. Regenerate it with `npx tsx scripts/build-sample-fixture.ts` when
// the catalog changes.
export function SampleConversation({ currency, className }: { currency?: string; className?: string }) {
  const [index, setIndex] = useState(0);
  const example = data.examples[Math.min(index, data.examples.length - 1)];
  const build = useMemo(
    () => ({
      ...derivedBuildFromSnapshot(example.snapshot, example.validation, currency ?? example.snapshot.currency),
      // The caption below dates the example; a "days old" note would read as a fault.
      pricesAsOf: undefined
    }),
    [example, currency]
  );
  const date = data.generated_at.slice(0, 10);

  return (
    <section
      aria-label="Example conversation"
      className={cn("w-full rounded-card border border-border bg-bg/80 p-4 text-left backdrop-blur-[2px]", className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="type-label text-caption text-text-muted">Example, not your chat</p>
        {data.examples.length > 1 ? (
          <PillTabs
            tabs={data.examples.map((item, i) => ({ value: String(i), label: item.label }))}
            value={String(index)}
            onChange={(value) => setIndex(Number(value))}
            ariaLabel="Example builds"
            size="sm"
          />
        ) : null}
      </div>
      <div className="mt-4 flex justify-end">
        <p className="max-w-[85%] rounded-card rounded-br-chip bg-surface-raised px-3.5 py-2 text-sm text-text">
          {example.prompt}
        </p>
      </div>
      <BuildCard key={example.id} builds={[build]} />
      <p className="text-caption text-text-muted">
        Prices from the catalog on <time dateTime={date}>{exampleDate(data.generated_at)}</time>; they have
        changed since. Nothing here was saved.
      </p>
    </section>
  );
}
