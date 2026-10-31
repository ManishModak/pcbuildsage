import type { PingResult } from "@/types/client";
import { formatLatency } from "@/lib/format";
import { describeProbeResult } from "@/lib/llm/probe-outcome";
import { StatusBadge } from "@/components/ui/status-badge";

const OUTCOME_LABEL = {
  key: "Key problem",
  quota: "Limit reached",
  tools: "No tool use",
  network: "Not reachable",
  unknown: "Check failed"
} as const;

/**
 * One plain outcome per model check (see describeProbeResult), with the raw
 * provider hint as the detail. Used by the settings chain builder and the
 * hosted onboarding step.
 */
export function ProbeResultView({ ping }: { ping: PingResult }) {
  const outcome = describeProbeResult(ping);
  if (outcome.kind === "ok") {
    return (
      <p className="flex flex-wrap items-center gap-2 text-caption text-text-secondary" aria-live="polite">
        <StatusBadge kind="ok" label="Works" />
        <span>Answered in <span className="font-mono">{formatLatency(ping.latencyMs)}</span> and can use tools.</span>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1" aria-live="polite" data-testid="probe-failure">
      <p className="flex flex-wrap items-center gap-2 text-caption text-text">
        <StatusBadge kind="warn" label={OUTCOME_LABEL[outcome.kind]} />
        <span>{outcome.message}</span>
      </p>
      {ping.hint ? (
        <p className="text-caption text-text-muted" title={ping.hint}>
          Details: {truncate(ping.hint)}
        </p>
      ) : null}
    </div>
  );
}

function truncate(value: string, max = 140): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
