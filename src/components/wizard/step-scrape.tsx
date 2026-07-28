"use client";

import { Database } from "lucide-react";
import type { StatusResponse } from "../lib/types";
import type { DataSourceChoice } from "./step-data-source";
import { ScrapeForm } from "./scrape-form";
import { SimplePanel } from "./simple-panel";

export function StepScrape({
  dataSource,
  onBack,
  onNext
}: {
  dataSource: DataSourceChoice | null;
  status: StatusResponse | null;
  onBack: () => void;
  onNext: () => void;
}) {
  if (dataSource === "existing") {
    return (
      <SimplePanel
        icon={Database}
        title="Using your existing database"
        description="Your local product data is ready. You can re-scrape later from settings whenever prices go stale."
        onBack={onBack}
        onNext={onNext}
      />
    );
  }
  return <ScrapeForm onBack={onBack} onNext={onNext} />;
}
