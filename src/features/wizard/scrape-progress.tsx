"use client";

import { useState } from "react";
import { Ban, Check, ChevronDown, ChevronRight, Copy, ExternalLink, TriangleAlert } from "lucide-react";
import { RuneSpinner } from "@/components/app/rune-spinner";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icon";
import { ProgressBar } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status-badge";

export type SiteRow = {
  key: string;
  site: string;
  category?: string;
  percent?: number;
  count?: number;
  status: "running" | "done" | "failed" | "skipped" | "cancelled";
  error?: string;
};

export function buildIssueUrl(row: SiteRow, logs: string[]): string {
  const target = `${row.site}${row.category ? `/${row.category}` : ""}`;
  const title = `[Scraper Failure] ${target}`;

  const sitePattern = row.site.toLowerCase();
  const relevantLogs = logs.filter((l) => l.toLowerCase().includes(sitePattern));
  const selectedLogs = relevantLogs.length > 0 ? relevantLogs.slice(-25) : logs.slice(-20);
  const logSnippet = selectedLogs.join("").trim();
  const truncatedSnippet = logSnippet.length > 1500 ? logSnippet.slice(-1500) : logSnippet;

  const bodyParts = [
    "### Scraper Failure Report",
    `- **Site**: ${row.site}`,
    `- **Category**: ${row.category || "N/A"}`,
    `- **Error**: \`${row.error || "Unknown error"}\``
  ];

  if (truncatedSnippet) {
    bodyParts.push(
      "",
      "<details>",
      "<summary>Log snippet</summary>",
      "",
      "```",
      truncatedSnippet,
      "```",
      "</details>"
    );
  }

  const params = new URLSearchParams({
    title,
    body: bodyParts.join("\n")
  });

  return `https://github.com/pcbuildsage/pcbuildsage/issues/new?${params.toString()}`;
}

// Per-site rows in one bordered list, then failures and a collapsible raw-log
// drawer. Failures never clear.
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
  const [copied, setCopied] = useState(false);
  const failures = rows.filter((row) => row.status === "failed");

  const handleCopy = async () => {
    if (!logs.length) return;
    try {
      await navigator.clipboard.writeText(logs.join(""));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy logs:", err);
    }
  };

  return (
    <div className="grid items-start gap-4 md:grid-cols-2">
      {/* Left column: progress per site */}
      <div className="flex h-full min-h-[320px] max-h-[min(75vh,640px)] flex-col overflow-hidden rounded-card border border-border bg-surface">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <span className="type-label text-sm text-text">Progress by site</span>
          <span className="flex items-center gap-2 text-caption text-text-secondary">
            {running ? (
              <>
                <RuneSpinner />
                Running
              </>
            ) : productsWritten !== undefined ? (
              `${productsWritten} products written`
            ) : (
              "Finished"
            )}
          </span>
        </div>

        <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
          {rows.length === 0 ? (
            <li className="px-4 py-6 text-center text-caption text-text-muted">Waiting for the first site…</li>
          ) : (
            rows.map((row) => <Row key={row.key} row={row} />)
          )}
        </ul>
      </div>

      {/* Right column: failures and raw log */}
      <div className="flex h-full max-h-[min(75vh,640px)] flex-col gap-4 md:min-h-[320px]">
        {failures.length ? (
          <div
            className="flex shrink-0 flex-col gap-2 rounded-card border px-4 py-3"
            style={{ borderColor: "color-mix(in srgb, var(--warn) 45%, transparent)" }}
          >
            <p className="flex items-center gap-2 text-caption font-medium" style={{ color: "var(--warn)" }}>
              <Icon icon={TriangleAlert} size={14} />
              {failures.length} {failures.length === 1 ? "site" : "sites"} failed. Data from the others is still saved.
            </p>
            <ul className="flex max-h-48 flex-col gap-2 overflow-y-auto pr-1">
              {failures.map((row) => (
                <li
                  key={row.key}
                  className="flex flex-col gap-1 border-b border-border pb-2 text-caption text-text-secondary last:border-0 last:pb-0"
                >
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span className="text-text">
                      {row.site}
                      {row.category ? `/${row.category}` : ""}
                    </span>
                    <a
                      href={buildIssueUrl(row, logs)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-caption text-accent hover:underline"
                    >
                      open issue
                      <Icon icon={ExternalLink} size={12} />
                    </a>
                  </div>
                  <span className="line-clamp-2 text-caption text-text-muted">{row.error}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Collapsed, the drawer is just its header; it fills the column only when open. */}
        <div
          className={cn(
            "flex min-h-0 flex-col overflow-hidden rounded-card border border-border bg-surface",
            showLog && "flex-1"
          )}
        >
          <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-2.5 text-caption text-text-secondary">
            <button
              type="button"
              aria-expanded={showLog}
              onClick={() => setShowLog((prev) => !prev)}
              className="flex items-center gap-1.5 transition-colors duration-150 hover:text-text"
            >
              <Icon icon={showLog ? ChevronDown : ChevronRight} size={14} />
              <span>Raw log ({logs.length} lines)</span>
            </button>
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={handleCopy}
                disabled={logs.length === 0}
                className="flex items-center gap-1 text-caption text-text-secondary transition-colors duration-150 hover:text-text disabled:opacity-40 disabled:hover:text-text-secondary"
                aria-label={copied ? "Copied logs to clipboard" : "Copy logs to clipboard"}
                title={copied ? "Copied" : "Copy logs"}
              >
                <Icon icon={copied ? Check : Copy} size={13} className={copied ? "text-accent" : ""} />
                <span>{copied ? "Copied" : "Copy"}</span>
              </button>
              <button
                type="button"
                aria-expanded={showLog}
                onClick={() => setShowLog((prev) => !prev)}
                className="transition-colors duration-150 hover:text-text"
              >
                {showLog ? "Hide" : "Show"}
              </button>
            </div>
          </div>
          {showLog ? (
            <pre className="min-h-0 flex-1 overflow-auto border-t border-border bg-bg px-4 py-3 font-mono text-caption text-text-secondary">
              {logs.length ? logs.join("") : "No output yet."}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// One site: name and status on the first line, progress and product count on the second.
function Row({ row }: { row: SiteRow }) {
  const tone = row.status === "failed" ? "blocking" : row.status === "skipped" ? "warn" : "accent";
  const name = `${row.site}${row.category ? `/${row.category}` : ""}`;

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 flex-1 truncate text-sm text-text" title={name}>
          {row.site}
          {row.category ? <span className="text-text-secondary">/{row.category}</span> : null}
        </span>
        <RowStatus row={row} />
      </div>
      <div className="flex items-center gap-3">
        <ProgressBar
          className="flex-1"
          value={row.status === "done" ? 100 : row.status === "failed" ? (row.percent ?? 100) : row.percent}
          tone={tone}
        />
        <span className="w-24 shrink-0 text-right text-caption tabular-nums text-text-secondary">
          {row.count !== undefined ? `${row.count} products` : "—"}
        </span>
      </div>
    </li>
  );
}

// Status is always a word plus an icon, never colour alone.
function RowStatus({ row }: { row: SiteRow }) {
  switch (row.status) {
    case "done":
      return <StatusBadge kind="ok" label="Done" />;
    case "failed":
      return <StatusBadge kind="blocking" label="Failed" />;
    case "skipped":
      return <StatusBadge kind="warn" label="Skipped" />;
    case "cancelled":
      return (
        <span className="flex items-center gap-1.5 text-caption text-text-secondary">
          <Icon icon={Ban} size={14} />
          Cancelled
        </span>
      );
    default:
      return (
        <span className="flex items-center gap-2 text-caption text-text-secondary">
          <RuneSpinner />
          {row.percent !== undefined ? `Running, ${Math.round(row.percent)}%` : "Running"}
        </span>
      );
  }
}
