"use client";

import { useMemo } from "react";
import type { BuildSnapshot } from "@/lib/catalog/build-snapshot";
import type { ValidationResult } from "@/types/client";
import { BuildCard } from "./build-card";
import { derivedBuildFromSnapshot } from "./build-derive";
import fixture from "../../../data/fixtures/sample-conversation.json";

interface SampleConversationFixture {
  version: number;
  generated_at: string;
  scope: { countryCode: string; currency: string };
  prompt: string;
  answer: string;
  validation: ValidationResult;
  snapshot: BuildSnapshot;
}

const data = fixture as unknown as SampleConversationFixture;

// A read-only example rendered from a static catalog snapshot. It imports the
// fixture at build time, so it makes no API calls, needs no key, and is never
// inserted into the chat transcript or saved as a user session. Regenerate it
// with `npx tsx scripts/build-sample-fixture.ts` when the catalog changes.
export function SampleConversation({ currency }: { currency?: string }) {
  const build = useMemo(
    () =>
      derivedBuildFromSnapshot(
        data.snapshot,
        data.validation,
        currency ?? data.snapshot.currency
      ),
    [currency]
  );

  return (
    <section
      aria-label="Example conversation"
      className="mt-4 w-full rounded-card border border-border bg-surface p-4 text-left"
    >
      <p className="inline-flex items-center rounded-pill bg-surface-raised px-3 py-1 text-caption font-medium text-text-secondary">
        Example — not your chat
      </p>
      <div className="mt-3 flex justify-end">
        <p className="max-w-[85%] rounded-card bg-surface-raised px-3 py-2 text-sm text-text">
          {data.prompt}
        </p>
      </div>
      <p className="mt-2 text-sm text-text-secondary">{data.answer}</p>
      <BuildCard builds={[build]} />
      <p className="mt-1 text-caption text-text-muted">
        Example build · catalog prices from {data.generated_at.slice(0, 10)}. Nothing here was
        saved.
      </p>
    </section>
  );
}
