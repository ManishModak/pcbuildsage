export const RUN_OUTCOME_STATUSES = ["succeeded", "partial", "failed", "cancelled"] as const;

export type RunOutcomeStatus = (typeof RUN_OUTCOME_STATUSES)[number];

export type RunOutcome = {
  status: RunOutcomeStatus;
  jobs_total: number;
  jobs_succeeded: number;
  jobs_failed: number;
  jobs_skipped: number;
  products_written: number | null;
  errors: string[];
};

export type ScrapeRunConfig = {
  profile: string;
  sites?: string[];
  categories?: string[];
  quick?: boolean;
  maxPages?: number;
  skipFresh?: number;
  noLlmFallback?: boolean;
  maxLlmCalls?: number;
  concurrency?: number;
  delayMs?: number;
  headed?: boolean;
  db?: string;
};

export type TestProfileConfig = {
  profile: string;
  site?: string;
  categories?: string[];
  headed?: boolean;
  delayMs?: number;
};

export function parseRunOutcome(value: unknown): RunOutcome | null {
  if (!isRecord(value)) return null;
  const candidate = isRecord(value.outcome) ? value.outcome : value;
  if (
    !RUN_OUTCOME_STATUSES.includes(candidate.status as RunOutcomeStatus) ||
    !isCount(candidate.jobs_total) ||
    !isCount(candidate.jobs_succeeded) ||
    !isCount(candidate.jobs_failed) ||
    !isCount(candidate.jobs_skipped) ||
    !(candidate.products_written === null || isCount(candidate.products_written)) ||
    !Array.isArray(candidate.errors) ||
    !candidate.errors.every((error) => typeof error === "string")
  ) {
    return null;
  }
  const jobsAccountedFor = candidate.jobs_succeeded + candidate.jobs_failed + candidate.jobs_skipped;
  const statusIsConsistent =
    (candidate.status === "succeeded" && candidate.jobs_failed === 0) ||
    (candidate.status === "partial" && candidate.jobs_failed > 0 && candidate.jobs_failed < candidate.jobs_total) ||
    candidate.status === "failed" ||
    candidate.status === "cancelled";
  return jobsAccountedFor === candidate.jobs_total && statusIsConsistent ? candidate as RunOutcome : null;
}

export function failedRunOutcome(error: string): RunOutcome {
  return {
    status: "failed",
    jobs_total: 0,
    jobs_succeeded: 0,
    jobs_failed: 0,
    jobs_skipped: 0,
    products_written: null,
    errors: [error]
  };
}

export function cancelledRunOutcome(): RunOutcome {
  return {
    status: "cancelled",
    jobs_total: 0,
    jobs_succeeded: 0,
    jobs_failed: 0,
    jobs_skipped: 0,
    products_written: null,
    errors: []
  };
}

export function resolveRunTermination(
  outcomes: RunOutcome[],
  code: number | null,
  signal: string | null,
  terminationRequested = false
): RunOutcome {
  if (terminationRequested) return cancelledRunOutcome();
  if (outcomes.length !== 1) {
    return failedRunOutcome(
      outcomes.length === 0
        ? `The scraper closed without a terminal outcome (code ${code ?? "null"}, signal ${signal ?? "none"}).`
        : "The scraper emitted more than one terminal outcome."
    );
  }
  const outcome = outcomes[0];
  const exitMatches = outcome.status === "succeeded" ? code === 0 : code !== 0;
  return exitMatches
    ? outcome
    : failedRunOutcome(`The scraper outcome did not match its exit code (${code ?? "null"}).`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}
