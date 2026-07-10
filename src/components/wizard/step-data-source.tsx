"use client";

import type { LucideIcon } from "lucide-react";
import { ArrowRight, Database, HardDriveDownload, Info, Radio, TriangleAlert } from "lucide-react";
import type { StatusResponse } from "../lib/types";
import { cn } from "../ui/cn";
import { Icon } from "../ui/icon";
import { Button } from "../ui/primitives";

export type DataSourceChoice = "existing" | "seed" | "scrape";

export function StepDataSource({
  status,
  choice,
  onChoose,
  onNext
}: {
  status: StatusResponse | null;
  choice: DataSourceChoice | null;
  onChoose: (choice: DataSourceChoice) => void;
  onNext: () => void;
}) {
  const dbExists = status?.database.exists ?? false;
  const pythonOk = status?.python.ok ?? true;
  const totalRows = status?.database.rowCounts.reduce((sum, row) => sum + row.count, 0) ?? 0;

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-text">Where should the data come from?</h1>
        <p className="text-base text-text-secondary">
          PCBuildSage works entirely from a local product database. Pick how to fill it — you can re-scrape or
          swap sources any time from settings.
        </p>
      </header>

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
            <p className="font-medium text-text">No Python interpreter was found.</p>
            <p className="text-caption text-text-secondary">
              Scraping runs a Python process. Install Python 3 (or set <code className="font-mono">PYTHON_PATH</code>,
              or create a <code className="font-mono">.venv</code>) to enable it. Seed download and loading an
              existing database still work.
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-3">
        <SourceCard
          icon={Database}
          selected={choice === "existing"}
          disabled={!dbExists}
          onSelect={() => onChoose("existing")}
          title="Load existing database"
          estimate="instant"
          description={
            dbExists
              ? `${totalRows.toLocaleString()} products already indexed${status ? ` at ${shortPath(status.database.path)}` : ""}.`
              : "No local database found yet — scrape or download a seed first."
          }
        />
        <SourceCard
          icon={HardDriveDownload}
          selected={choice === "seed"}
          onSelect={() => onChoose("seed")}
          title="Download a community seed"
          estimate="~1 min"
          description="Fetch a shared, recent snapshot for your region. Fastest way to start with real data."
        />
        <SourceCard
          icon={Radio}
          selected={choice === "scrape"}
          disabled={!pythonOk}
          onSelect={() => onChoose("scrape")}
          title="Scrape fresh"
          estimate="~10 min"
          description="Crawl retailer sites now for the newest prices. Configurable per site, category, and depth."
        />
      </div>

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
    </section>
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
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex items-start gap-4 rounded-card border bg-surface p-4 text-left transition-colors duration-150",
        selected ? "border-accent" : "border-border hover:border-text-muted",
        disabled && "cursor-not-allowed opacity-50 hover:border-border"
      )}
    >
      <span
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-btn border",
          selected ? "border-accent text-accent" : "border-border text-text-secondary"
        )}
      >
        <Icon icon={icon} size={20} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-2">
          <span className="text-base font-medium text-text">{title}</span>
          <span className="rounded-chip bg-surface-raised px-2 py-0.5 font-mono text-caption text-text-secondary">
            {estimate}
          </span>
        </span>
        <span className="text-caption text-text-secondary">{description}</span>
      </span>
    </button>
  );
}

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.slice(-2).join("/");
}
