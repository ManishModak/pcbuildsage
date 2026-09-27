"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Wrench,
  Globe,
  Search,
  ExternalLink,
  Bot,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Sparkles,
  Layers
} from "lucide-react";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icon";

export type ToolPart = {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  toolName?: string;
};

function toolName(part: ToolPart): string {
  if (part.toolName) return part.toolName;
  return part.type.startsWith("tool-") ? part.type.slice("tool-".length) : part.type;
}

// Summarize a tool result into the chip's right-hand phrase.
function summarize(name: string, part: ToolPart): string {
  if (part.state === "output-error") return part.errorText ? "error" : "error";
  const isRunning = part.state && part.state !== "output-available";
  const input = part.input as Record<string, unknown> | undefined;
  const output = part.output as Record<string, unknown> | undefined;

  if (name === "consult") {
    const mode = input?.mode;
    if (isRunning) return "research in progress…";
    if (!output) return "researched";
    if (output.error || output.label === "unverified") {
      const errStr = typeof output.error === "string" ? output.error : "research failed";
      return `research unavailable (${errStr})`;
    }
    if (mode === "component_specs") {
      const specs = output.specs as Record<string, unknown> | undefined;
      const model = typeof specs?.model === "string" ? specs.model : input?.name;
      return model ? `${model} specs verified` : "specs researched";
    }
    if (mode === "build_audit") {
      const verdicts = Array.isArray(output.verdicts) ? output.verdicts : [];
      return `${verdicts.length} advisory check${verdicts.length === 1 ? "" : "s"}`;
    }
    return "consult completed";
  }

  if (isRunning) return "running…";
  if (!output) return "done";

  if (name === "validate_build") {
    const outObj = output as Record<string, unknown>;
    if (outObj.builds && typeof outObj.builds === "object") {
      const buildEntries = Object.entries(outObj.builds) as Array<[string, { issues?: Array<{ severity?: string }>; valid?: boolean }]>;
      const totalBlocking = buildEntries.reduce(
        (sum, [, b]) => sum + (Array.isArray(b.issues) ? b.issues.filter((i) => i.severity === "blocking").length : 0),
        0
      );
      if (totalBlocking > 0) return `${totalBlocking} blocking issue${totalBlocking === 1 ? "" : "s"}`;
      const allValid = buildEntries.every(([, b]) => b.valid);
      const totalIssues = buildEntries.reduce((sum, [, b]) => sum + (Array.isArray(b.issues) ? b.issues.length : 0), 0);
      return allValid ? `${buildEntries.length} compatible` : `${totalIssues} issue${totalIssues === 1 ? "" : "s"}`;
    }
    const issues = Array.isArray(output.issues) ? (output.issues as Array<{ severity?: string }>) : [];
    const blocking = issues.filter((issue) => issue.severity === "blocking").length;
    if (blocking > 0) return `${blocking} blocking issue${blocking === 1 ? "" : "s"}`;
    return output.valid ? "compatible" : `${issues.length} issue${issues.length === 1 ? "" : "s"}`;
  }
  if (name === "present_build") {
    if (isRunning) return "preparing build card…";
    const builds = Array.isArray(input?.builds) ? input!.builds : [];
    return `${builds.length} build${builds.length === 1 ? "" : "s"} presented`;
  }
  if (name === "search_products") {
    const results = Array.isArray(output.results) ? output.results : [];
    return `${results.length} result${results.length === 1 ? "" : "s"}`;
  }
  return "done";
}

export function ToolChip({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const rawName = toolName(part);
  const isConsult = rawName === "consult";
  const displayName = isConsult ? "subagent" : rawName;
  const separator = isConsult ? ">" : "→";

  const running = part.state && part.state !== "output-available" && part.state !== "output-error";
  const input = part.input as Record<string, unknown> | undefined;
  const output = part.output as Record<string, unknown> | undefined;
  const hasOutputError = Boolean(output?.error);
  const isError = part.state === "output-error" || (isConsult && hasOutputError);

  return (
    <div className="my-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          "inline-flex max-w-full items-center gap-2 rounded-chip border px-2.5 py-1.5 font-mono text-caption transition-colors duration-150",
          isError
            ? "border-blocking/50 text-blocking"
            : running && isConsult
              ? "border-accent/40 bg-surface-raised text-accent hover:border-accent"
              : "border-border text-text-secondary hover:border-accent hover:text-text"
        )}
        style={isError ? { borderColor: "color-mix(in srgb, var(--blocking) 45%, transparent)" } : undefined}
      >
        <Icon
          icon={isConsult ? Bot : Wrench}
          size={13}
          className={running ? "pcbs-spin text-accent" : undefined}
        />
        <span className="truncate font-semibold text-text">{displayName}</span>
        <span aria-hidden className="text-text-muted font-bold">
          {separator}
        </span>
        <span className="truncate">{summarize(rawName, part)}</span>
        <Icon icon={open ? ChevronDown : ChevronRight} size={13} />
      </button>

      {open ? (
        <div className="mt-1.5 space-y-3 rounded-card border border-border bg-surface p-3.5 shadow-sm">
          {isConsult && running ? (
            <ConsultRunningCard input={input} />
          ) : isConsult && output && !isError ? (
            <ConsultResultCard input={input} output={output} />
          ) : isConsult && isError ? (
            <div className="space-y-2 rounded-card border border-blocking/30 bg-surface-raised p-3 text-caption">
              <div className="flex items-center gap-2 font-semibold text-blocking">
                <Icon icon={AlertCircle} size={14} />
                <span>Subagent Research Failed</span>
              </div>
              <p className="text-text-secondary">
                {String(output?.error || part.errorText || "Subagent research could not be completed.")}
              </p>
              <p className="text-text-muted">
                Component specifications remain unresolved. Build validation requires verified specifications before clearing compatibility.
              </p>
            </div>
          ) : (
            <>
              <ToolBlock label="input" value={part.input} />
              {isError ? <ToolBlock label="error" value={part.errorText} /> : <ToolBlock label="output" value={part.output} />}
            </>
          )}

          {/* Collapsible raw JSON for consult power-users */}
          {isConsult && (
            <details className="pt-1 text-caption text-text-muted">
              <summary className="cursor-pointer select-none text-caption hover:text-text">Raw payload</summary>
              <div className="mt-2 space-y-2">
                <ToolBlock label="input" value={part.input} />
                {isError ? <ToolBlock label="error" value={output?.error || part.errorText} /> : <ToolBlock label="output" value={part.output} />}
              </div>
            </details>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ConsultRunningCard({ input }: { input?: Record<string, unknown> }) {
  const name = typeof input?.name === "string" ? input.name : undefined;
  return (
    <div className="space-y-2 rounded-card border border-accent/20 bg-surface-raised/60 p-3.5">
      <p className="text-sm text-text">Research in progress.</p>
      {name ? <p className="text-caption text-text-secondary">Target: {name}</p> : null}
    </div>
  );
}

function ConsultResultCard({ input, output }: { input?: Record<string, unknown>; output: Record<string, unknown> }) {
  const mode = output.mode || input?.mode;

  if (output.error || output.label === "unverified") {
    return (
      <div className="space-y-2 rounded-card border border-warn/30 bg-warn/5 p-3 text-caption">
        <div className="flex items-center gap-2 font-semibold text-warn">
          <Icon icon={AlertCircle} size={14} />
          <span>Subagent Research Unavailable</span>
        </div>
        <p className="text-text-secondary">{String(output.error || "Basic identity verified; fine-grained physical specs not published in indexed sheets.")}</p>
        <p className="text-text-muted">
          Deterministic rules will proceed with advisory/catalog heuristics where available.
        </p>
      </div>
    );
  }

  if (mode === "component_specs") {
    const specs = (output.specs || {}) as Record<string, unknown>;
    const brand = typeof specs.brand === "string" ? specs.brand : undefined;
    const model = typeof specs.model === "string" ? specs.model : typeof input?.name === "string" ? input.name : "Component";
    const confidence = typeof output.confidence === "string" ? output.confidence : "medium";
    const cached = Boolean(output.cached);
    const sources = Array.isArray(output.sources) ? output.sources : [];
    const actions = Array.isArray(output.actions) ? (output.actions as Array<{ tool: string; query?: string; url?: string; resultCount?: number }>) : [];

    const keyMetrics: Array<{ label: string; value: string | number }> = [];
    if (specs.tdp_w) keyMetrics.push({ label: "TDP", value: `${specs.tdp_w}W` });
    if (specs.wattage) keyMetrics.push({ label: "Wattage", value: `${specs.wattage}W` });
    if (specs.length_mm) keyMetrics.push({ label: "Length", value: `${specs.length_mm} mm` });
    if (specs.recommended_psu_w) keyMetrics.push({ label: "Rec. PSU", value: `${specs.recommended_psu_w}W` });
    if (specs.vram_gb) keyMetrics.push({ label: "VRAM", value: `${specs.vram_gb} GB` });
    if (specs.socket) keyMetrics.push({ label: "Socket", value: String(specs.socket) });
    if (specs.ddr) keyMetrics.push({ label: "Memory", value: String(specs.ddr) });
    if (specs.form_factor) keyMetrics.push({ label: "Form Factor", value: String(specs.form_factor) });

    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2.5">
          <div className="flex items-center gap-2">
            <Icon icon={Sparkles} size={15} className="text-accent" />
            <div>
              <p className="text-sm font-semibold text-text">
                {brand ? `${brand} ` : ""}
                {model}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "rounded-pill px-2 py-0.5 text-caption font-medium",
                confidence === "high"
                  ? "bg-ok/10 text-ok"
                  : confidence === "medium"
                    ? "bg-warn/10 text-warn"
                    : "bg-text-muted/20 text-text-muted"
              )}
            >
              {confidence} confidence
            </span>
            {cached ? (
              <span className="rounded-pill bg-surface-raised px-2 py-0.5 text-caption text-text-muted">Cached</span>
            ) : (
              <span className="rounded-pill bg-accent/10 px-2 py-0.5 text-caption text-accent">Researched</span>
            )}
          </div>
        </div>

        {keyMetrics.length > 0 ? (
          <div>
            <p className="mb-1.5 text-caption font-medium uppercase tracking-wider text-text-muted">Researched Specs</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {keyMetrics.map((metric) => (
                <div key={metric.label} className="rounded-chip border border-border bg-surface-raised px-2.5 py-1.5">
                  <span className="block text-caption text-text-muted">{metric.label}</span>
                  <span className="font-mono text-sm font-semibold text-text">{metric.value}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-caption text-text-muted">Basic identity verified; fine-grained physical specs not published in indexed sheets.</p>
        )}

        {actions.length > 0 ? (
          <div>
            <p className="mb-1 text-caption font-medium uppercase tracking-wider text-text-muted">Subagent Execution Trace</p>
            <div className="space-y-1.5 font-mono text-caption">
              {actions.map((act, i) => (
                <div key={i} className="flex items-center gap-2 rounded border border-border/50 bg-surface px-2.5 py-1 text-text-secondary">
                  <Icon icon={act.tool === "search_web" ? Search : Globe} size={12} className="shrink-0 text-accent" />
                  <span className="font-semibold text-text">{act.tool}:</span>
                  <span className="truncate">{act.query || act.url}</span>
                  {act.resultCount !== undefined ? (
                    <span className="ml-auto shrink-0 text-xs text-text-muted">({act.resultCount} results)</span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {sources.length > 0 ? (
          <div>
            <p className="mb-1 text-caption font-medium uppercase tracking-wider text-text-muted">Grounding Sources</p>
            <ul className="space-y-1">
              {sources.slice(0, 3).map((source, index) => {
                const url = typeof source === "string" ? source : source.url;
                const title = typeof source === "string" ? source : source.title || source.url;
                return (
                  <li key={index} className="flex items-center gap-1.5 text-caption">
                    <Icon icon={ExternalLink} size={11} className="shrink-0 text-text-muted" />
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="truncate text-accent underline-offset-2 hover:underline"
                    >
                      {title}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    );
  }

  if (mode === "build_audit") {
    const verdicts = Array.isArray(output.verdicts)
      ? (output.verdicts as Array<{ pair?: string; severity?: string; detail?: string }>)
      : [];

    return (
      <div className="space-y-2.5">
        <div className="flex items-center gap-2 border-b border-border pb-2">
          <Icon icon={Layers} size={14} className="text-accent" />
          <span className="text-sm font-semibold text-text">Tier 2 Advisory Audit Results</span>
        </div>
        <div className="space-y-2">
          {verdicts.map((v, i) => (
            <div key={i} className="rounded-chip border border-border bg-surface-raised p-2.5 text-caption">
              <div className="flex items-center gap-2 font-mono font-medium text-text">
                <Icon
                  icon={v.severity === "ok" ? CheckCircle2 : v.severity === "warning" ? AlertCircle : HelpCircle}
                  size={13}
                  className={v.severity === "ok" ? "text-ok" : v.severity === "warning" ? "text-warn" : "text-text-muted"}
                />
                <span>{v.pair || `Check ${i + 1}`}</span>
              </div>
              {v.detail ? <p className="mt-1 text-text-secondary">{v.detail}</p> : null}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return <ToolBlock label="output" value={output} />;
}

function ToolBlock({ label, value }: { label: string; value: unknown }) {
  if (value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div>
      <p className="mb-1 text-caption font-medium uppercase tracking-wide text-text-muted">{label}</p>
      <pre className="max-h-64 overflow-auto rounded-chip bg-bg p-2 font-mono text-caption text-text-secondary">
        {text}
      </pre>
    </div>
  );
}
