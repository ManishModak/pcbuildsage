"use client";

import type { LucideIcon } from "lucide-react";
import { ArrowRight, Check, Database, Info, Radio, TriangleAlert } from "lucide-react";
import type { StatusResponse } from "@/types/client";
import { cn } from "@/components/ui/cn";
import { RuneSpinner } from "@/components/app/rune-spinner";
import { Icon } from "@/components/ui/icon";
import { Button, Card, ChoiceControl, ChoiceGroup } from "@/components/ui/primitives";
import { StepHeader } from "./simple-panel";

export type DataSourceChoice = "existing" | "scrape";
export type StatusLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: StatusResponse };

export function StepDataSource({
  statusState,
  choice,
  onChoose,
  onRetry,
  onNext
}: {
  statusState: StatusLoadState;
  choice: DataSourceChoice | null;
  onChoose: (choice: DataSourceChoice) => void;
  onRetry: () => void;
  onNext: () => void;
}) {
  return (
    <section className="flex flex-col gap-6">
      <StepHeader title="Where should the data come from?">
        PCBuildSage works from a local product database. Load the one you have or fetch a fresh copy. You can
        change this any time from settings.
      </StepHeader>

      {statusState.status === "loading" ? (
        <Card className="flex items-center gap-3 p-4 text-sm text-text-secondary" aria-live="polite">
          <RuneSpinner />
          Checking Python and your local catalog…
        </Card>
      ) : statusState.status === "error" ? (
        <Card className="flex flex-col items-start gap-3 p-4" role="alert">
          <div>
            <p className="text-sm font-medium text-text">Could not check this computer</p>
            <p className="text-caption text-text-secondary">{statusState.message}</p>
          </div>
          <Button variant="ghost" onClick={onRetry}>Check again</Button>
        </Card>
      ) : (
        <DataSourceChoices
          status={statusState.data}
          choice={choice}
          onChoose={onChoose}
          onNext={onNext}
        />
      )}
    </section>
  );
}

function DataSourceChoices({
  status,
  choice,
  onChoose,
  onNext
}: {
  status: StatusResponse;
  choice: DataSourceChoice | null;
  onChoose: (choice: DataSourceChoice) => void;
  onNext: () => void;
}) {
  const dbExists = status.database.exists;
  const pythonOk = Boolean(status.python?.ok);
  const totalRows = status.database.rowCounts.reduce((sum, row) => sum + row.count, 0);

  return (
    <>
      {!pythonOk ? (
        <div
          className="flex items-start gap-3 rounded-card border px-4 py-3 text-sm"
          style={{
            color: "var(--warn)",
            borderColor: "color-mix(in srgb, var(--warn) 45%, transparent)",
            backgroundColor: "color-mix(in srgb, var(--warn) 8%, transparent)"
          }}
        >
          <Icon icon={TriangleAlert} size={18} />
          <div className="flex flex-col gap-1 text-text">
            <p className="font-medium text-text">Python was not found.</p>
            <p className="text-caption text-text-secondary">
              Fetching runs as a Python process. Install Python 3, set <code className="font-mono">PYTHON_PATH</code>{" "}
              or create a <code className="font-mono">.venv</code> to turn it on. Loading an existing database
              still works.
            </p>
          </div>
        </div>
      ) : null}

      <ChoiceGroup label="Data source" legendClassName="sr-only">
        <div className="overflow-hidden rounded-card border border-border bg-surface divide-y divide-border">
        <SourceCard
          icon={Database}
          selected={choice === "existing"}
          disabled={!dbExists}
          onSelect={() => onChoose("existing")}
          title="Load existing database"
          estimate="Instant"
          description={
            dbExists
              ? `${totalRows.toLocaleString()} products already indexed${status.database.path ? ` at ${shortPath(status.database.path)}` : ""}.`
              : "No local database found yet. Fetch fresh data to create one."
          }
        />
        <SourceCard
          icon={Radio}
          selected={choice === "scrape"}
          disabled={!pythonOk}
          onSelect={() => onChoose("scrape")}
          title="Fetch fresh data"
          estimate="About 10 min"
          description="Crawl retailer sites now for the newest prices. You choose the sites, categories and depth."
        />
        </div>
      </ChoiceGroup>

      {dbExists ? (
        <p className="flex items-center gap-2 text-caption text-text-muted">
          <Icon icon={Info} size={14} />
          You can keep your existing data and skip straight to setup.
        </p>
      ) : null}

      <div className="flex justify-end">
        <Button iconRight={ArrowRight} disabled={choice === null} onClick={onNext}>
          Continue
        </Button>
      </div>
    </>
  );
}

function SourceCard({
  icon,
  title,
  estimate,
  description,
  selected,
  disabled,
  onSelect
}: {
  icon: LucideIcon;
  title: string;
  estimate: string;
  description: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <ChoiceControl
      type="radio"
      name="data-source"
      value={title}
      checked={selected}
      disabled={disabled}
      onChange={onSelect}
      className={cn(
        "flex items-start gap-4 p-4 text-left transition-colors duration-150",
        selected && "bg-surface-raised",
        !selected && !disabled && "hover:bg-surface-raised",
        disabled && "cursor-not-allowed opacity-50"
      )}
    >
      {selected ? <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-accent" /> : null}
      <span
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-btn border",
          selected ? "border-accent text-accent" : "border-border text-text-secondary"
        )}
      >
        <Icon icon={icon} size={20} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-x-3">
          <span className="type-title text-base text-text">{title}</span>
          <span className="text-caption text-text-secondary">{estimate}</span>
        </span>
        <span className="text-caption text-text-secondary">{description}</span>
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-pill border",
          selected ? "border-accent bg-accent text-on-accent" : "border-border"
        )}
      >
        {selected ? <Icon icon={Check} size={12} /> : null}
      </span>
    </ChoiceControl>
  );
}

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.slice(-2).join("/");
}
