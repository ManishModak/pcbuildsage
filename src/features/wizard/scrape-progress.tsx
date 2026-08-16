"use client";

import { useState } from "react";
import {
  Ban,
  Check,
  CircleCheck,
  Copy,
  ExternalLink,
  OctagonX,
  SkipForward,
  Terminal,
  TriangleAlert
} from "lucide-react";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icon";
import { ProgressBar } from "@/components/ui/primitives";

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
    <div className="grid gap-4 md:grid-cols-2 items-start">
      {/* Left Column: Scrape progress table */}
      <div className="flex flex-col overflow-hidden rounded-card border border-border bg-surface h-full min-h-[320px] max-h-[min(75vh,640px)]">
        <div className="shrink-0 flex items-center justify-between border-b border-border px-4 py-2.5">
          <span className="flex items-center gap-2 text-sm text-text">
            <Icon icon={Terminal} size={16} className="text-text-secondary" />
            Scrape progress
          </span>
          <span className="font-mono text-caption text-text-secondary">
            {running ? "running…" : productsWritten !== undefined ? `${productsWritten} products written` : "finished"}
          </span>
        </div>

        <ul className="flex-1 min-h-0 divide-y divide-border overflow-y-auto">
          {rows.length === 0 ? (
            <li className="px-4 py-6 text-center text-caption text-text-muted">Waiting for the first site…</li>
          ) : (
            rows.map((row) => <Row key={row.key} row={row} />)
          )}
        </ul>
      </div>

      {/* Right Column: Failures and Raw logs */}
      <div className="flex flex-col gap-4 h-full min-h-[320px] max-h-[min(75vh,640px)]">
        {failures.length ? (
          <div
            className="shrink-0 flex flex-col gap-2 rounded-card border px-4 py-3"
            style={{ borderColor: "color-mix(in srgb, var(--warn) 45%, transparent)" }}
          >
            <p className="flex items-center gap-2 text-caption font-medium" style={{ color: "var(--warn)" }}>
              <Icon icon={TriangleAlert} size={14} />
              {failures.length} {failures.length === 1 ? "site" : "sites"} failed — data from the others is still saved.
            </p>
            <div className="flex flex-col gap-2 max-h-48 overflow-y-auto pr-1">
              {failures.map((row) => (
                <div key={row.key} className="flex flex-col gap-1 text-caption text-text-secondary border-b border-border/50 pb-2 last:border-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2 font-mono text-text">
                    <span>{row.site}{row.category ? `/${row.category}` : ""}</span>
                    <span className="text-text-muted font-sans">·</span>
                    <a
                      href={buildIssueUrl(row, logs)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-accent hover:underline font-sans text-caption"
                    >
                      open issue
                      <Icon icon={ExternalLink} size={12} />
                    </a>
                  </div>
                  <span className="text-caption text-text-muted line-clamp-2">{row.error}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex flex-col flex-1 min-h-0 overflow-hidden rounded-card border border-border bg-surface">
          <div className="shrink-0 flex items-center justify-between px-4 py-2.5 text-caption text-text-secondary">
            <button
              type="button"
              aria-expanded={showLog}
              onClick={() => setShowLog((prev) => !prev)}
              className="flex items-center gap-1.5 hover:text-text transition-colors"
            >
              <span>Raw log ({logs.length} lines)</span>
            </button>
            <div className="flex items-center gap-2 font-mono">
              <button
                type="button"
                onClick={handleCopy}
                disabled={logs.length === 0}
                className="flex items-center gap-1 text-caption text-text-secondary hover:text-text disabled:opacity-40 disabled:hover:text-text-secondary transition-colors"
                aria-label={copied ? "Copied logs to clipboard" : "Copy logs to clipboard"}
                title={copied ? "Copied" : "Copy logs"}
              >
                <Icon icon={copied ? Check : Copy} size={13} className={copied ? "text-accent" : ""} />
                <span>{copied ? "copied" : "copy"}</span>
              </button>
              <span className="text-text-muted font-sans">·</span>
              <button
                type="button"
                aria-expanded={showLog}
                onClick={() => setShowLog((prev) => !prev)}
                className="hover:text-text transition-colors"
              >
                {showLog ? "hide" : "show"}
              </button>
            </div>
          </div>
          {showLog ? (
            <pre className="flex-1 min-h-0 overflow-auto border-t border-border bg-bg px-4 py-3 font-mono text-caption text-text-secondary">
              {logs.length ? logs.join("") : "No output yet."}
            </pre>
          ) : null}
        </div>
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
        : row.status === "cancelled"
          ? Ban
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
      <span
        className={cn("min-w-0 flex-1 truncate font-mono text-caption text-text")}
        title={`${row.site}${row.category ? `/${row.category}` : ""}`}
      >
        {row.site}
        {row.category ? <span className="text-text-secondary">/{row.category}</span> : null}
      </span>
      <div className="w-32 shrink-0">
        <ProgressBar
          value={row.status === "done" ? 100 : row.status === "failed" ? (row.percent ?? 100) : row.percent}
          tone={tone}
        />
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
