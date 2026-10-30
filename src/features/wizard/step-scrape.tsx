"use client";

import type { DataSourceChoice } from "./step-data-source";
import { ScrapeForm } from "./scrape-form";
import { SimplePanel } from "./simple-panel";

export function StepScrape({
  dataSource,
  onBack,
  onNext
}: {
  dataSource: DataSourceChoice | null;
  onBack: () => void;
  onNext: () => void;
}) {
  if (dataSource === "existing") {
    return (
      <SimplePanel
        title="Using your existing database"
        description="Your local product data is ready. You can fetch fresh prices later from settings."
        onBack={onBack}
        onNext={onNext}
      />
    );
  }
  return <ScrapeForm onBack={onBack} onNext={onNext} />;
}
