"use client";

import { ScrapeForm } from "./scrape-form";

/** Local setup's fetch step: scrape retailer listings into a new database. */
export function StepScrape({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  return <ScrapeForm onBack={onBack} onNext={onNext} />;
}
