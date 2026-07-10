"use client";

import { useState } from "react";
import { CircleCheck, OctagonX, SkipForward, Terminal, TriangleAlert } from "lucide-react";
import { cn } from "../ui/cn";
import { Icon } from "../ui/icon";
import { ProgressBar } from "../ui/primitives";

export type SiteRow = {
  key: string;
  site: string;
  category?: string;
  percent?: number;
  count?: number;
  status: "running" | "done" | "failed" | "skipped";
  error?: string;
};

// Terminal aesthetic inside the web: a surface panel of per-site rows with mono
// progress bars, plus a collapsible raw-log drawer. Failures never clear.
export function ScrapeProgress({
  rows,
  logs,
  running,
  productsWritten
}: {
  rows: SiteRow[];
  logs: string[];
  running: boolean;
  productsWritten?: number;
}) {
  const [showLog, setShowLog] = useState(false);
  const failures = rows.filter((row) => row.status === "failed");

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-card border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <span className="flex items-center gap-2 text-sm text-text">
            <Icon icon={Terminal} size={16} className="text-text-secondary" />
            Scrape progress
          </span>
          <span className="font-mono text-caption text-text-secondary">
            {running ? "running…" : productsWritten !== undefined ? `${productsWritten} products written` : "finished"}
          </span>
        </div>

        <ul className="divide-y divide-border">
          {rows.length === 0 ? (
            <li className="px-4 py-6 text-center text-caption text-text-muted">Waiting for the first site…</li>
          ) : (
            rows.map((row) => <Row key={row.key} row={row} />)
          )}
        </ul>
      </div>

      {failures.length ? (
        <div
          className="flex flex-col gap-2 rounded-card border px-4 py-3"
          style={{ borderColor: "color-mix(in srgb, var(--warn) 45%, transparent)" }}
        >
          <p className="flex items-center gap-2 text-caption font-medium" style={{ color: "var(--warn)" }}>
            <Icon icon={TriangleAlert} size={14} />
            {failures.length} {failures.length === 1 ? "site" : "sites"} failed — data from the others is still saved.
          </p>
          {failures.map((row) => (
            <div key={row.key} className="flex flex-wrap items-center gap-2 text-caption text-text-secondary">
              <span className="font-mono text-text">{row.site}{row.category ? `/${row.category}` : ""}</span>
              <span className="truncate">{row.error}</span>
              <button
                type="button"
                onClick={() => setShowLog(true)}
                className="text-accent hover:underline"
              >
                view log
              </button>
              <span className="text-text-muted">·</span>
              <a
                href="https://github.com/pcbuildsage/pcbuildsage/issues/new"
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                this profile may need a fix — open an issue
              </a>
            </div>
          ))}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-card border border-border bg-surface">
        <button
          type="button"
          aria-expanded={showLog}
          onClick={() => setShowLog((prev) => !prev)}
          className="flex w-full items-center justify-between px-4 py-2.5 text-caption text-text-secondary hover:text-text"
        >
          <span>Raw log ({logs.length} lines)</span>
          <span className="font-mono">{showLog ? "hide" : "show"}</span>
        </button>
        {showLog ? (
          <pre className="max-h-56 overflow-auto border-t border-border bg-bg px-4 py-3 font-mono text-caption text-text-secondary">
            {logs.length ? logs.join("") : "No output yet."}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

function Row({ row }: { row: SiteRow }) {
  const icon =
    row.status === "done"
      ? CircleCheck
      : row.status === "failed"
        ? OctagonX
        : row.status === "skipped"
          ? SkipForward
          : null;
  const iconColor =
    row.status === "done"
      ? "var(--ok)"
      : row.status === "failed"
        ? "var(--blocking)"
        : "var(--text-secondary)";
  const tone = row.status === "failed" ? "blocking" : row.status === "skipped" ? "warn" : "accent";

  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <span className={cn("min-w-0 flex-1 truncate font-mono text-caption text-text")}>
        {row.site}
        {row.category ? <span className="text-text-secondary">/{row.category}</span> : null}
      </span>
      <div className="w-32 shrink-0">
        <ProgressBar value={row.status === "done" ? 100 : row.percent} tone={tone} />
      </div>
      <span className="w-16 shrink-0 text-right font-mono text-caption text-text-secondary">
        {row.count !== undefined ? `${row.count}` : "—"}
      </span>
      <span className="w-5 shrink-0 text-right" style={{ color: iconColor }}>
        {icon ? (
          <Icon icon={icon} size={15} label={row.status} className="inline" />
        ) : (
          <span className="inline-block font-mono text-caption">
            {row.percent !== undefined ? `${Math.round(row.percent)}%` : ""}
          </span>
        )}
      </span>
    </li>
  );
}
