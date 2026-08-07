"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
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
  if (part.state && part.state !== "output-available") return "running…";
  const output = part.output as Record<string, unknown> | undefined;
  if (!output) return "done";
  if (name === "validate_build") {
    const issues = Array.isArray(output.issues) ? (output.issues as Array<{ severity?: string }>) : [];
    const blocking = issues.filter((issue) => issue.severity === "blocking").length;
    if (blocking > 0) return `${blocking} blocking issue${blocking === 1 ? "" : "s"}`;
    return output.valid ? "compatible" : `${issues.length} issue${issues.length === 1 ? "" : "s"}`;
  }
  if (name === "search_products") {
    const results = Array.isArray(output.results) ? output.results : [];
    return `${results.length} result${results.length === 1 ? "" : "s"}`;
  }
  if (name === "consult") {
    const mode = (part.input as Record<string, unknown> | undefined)?.mode;
    return typeof mode === "string" ? `${mode} researched` : "researched";
  }
  return "done";
}

export function ToolChip({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const name = toolName(part);
  const running = part.state && part.state !== "output-available" && part.state !== "output-error";
  const isError = part.state === "output-error";

  return (
    <div className="my-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          "inline-flex max-w-full items-center gap-2 rounded-chip border px-2.5 py-1.5 font-mono text-caption transition-colors duration-150",
          isError ? "border-blocking/50 text-blocking" : "border-border text-text-secondary hover:border-accent hover:text-text"
        )}
        style={isError ? { borderColor: "color-mix(in srgb, var(--blocking) 45%, transparent)" } : undefined}
      >
        <Icon icon={Wrench} size={13} className={running ? "pcbs-spin" : undefined} />
        <span className="truncate text-text">{name}</span>
        <span aria-hidden className="text-text-muted">
          →
        </span>
        <span className="truncate">{summarize(name, part)}</span>
        <Icon icon={open ? ChevronDown : ChevronRight} size={13} />
      </button>
      {open ? (
        <div className="mt-1.5 space-y-2 rounded-chip border border-border bg-surface p-3">
          <ToolBlock label="input" value={part.input} />
          {isError ? (
            <ToolBlock label="error" value={part.errorText} />
          ) : (
            <ToolBlock label="output" value={part.output} />
          )}
        </div>
      ) : null}
    </div>
  );
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
