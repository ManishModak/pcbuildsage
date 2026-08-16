import type { RunOutcome } from "@/contracts/scrape";
import type { SiteRow } from "./scrape-progress";

// State for a single scrape run's SSE stream. Kept in one reducer so every
// server event applies atomically instead of fanning out across setters.
export type ScrapeStreamState = {
  rows: Map<string, SiteRow>;
  logs: string[];
  productsWritten: number | undefined;
  runError: string | null;
  outcome: RunOutcome | null;
};

export type ScrapeStreamAction =
  | { type: "reset" }
  | { type: "log"; message: string }
  | { type: "site_started"; site: string; category?: string }
  | {
      type: "progress";
      site: string;
      category?: string;
      percent?: number;
      products_seen?: number;
      skipped?: boolean;
    }
  | { type: "site_failed"; site: string; category?: string; error: string }
  | { type: "outcome"; outcome: RunOutcome }
  | { type: "error"; error?: string; status?: number };

export function createInitialScrapeStreamState(): ScrapeStreamState {
  return { rows: new Map(), logs: [], productsWritten: undefined, runError: null, outcome: null };
}

function rowKey(site?: string, category?: string): string {
  return `${site ?? ""}${category ? `/${category}` : ""}`;
}

/**
 * Translate a raw SSE frame into a reducer action. Mirrors the server's
 * convention of putting the discriminator either in the payload `type`
 * field or in the SSE event name. Returns null for frames we don't track.
 */
export function toScrapeStreamAction(event: string, data: unknown): ScrapeStreamAction | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }

  const payload = data as Record<string, unknown>;
  const type = typeof payload.type === "string" ? payload.type : event;

  switch (type) {
    case "log": {
      if (typeof payload.message !== "string") return null;
      return { type: "log", message: payload.message };
    }
    case "site_started": {
      if (typeof payload.site !== "string" || !payload.site.trim()) return null;
      const category = typeof payload.category === "string" ? payload.category : undefined;
      return { type: "site_started", site: payload.site, category };
    }
    case "progress": {
      if (typeof payload.site !== "string" || !payload.site.trim()) return null;
      const category = typeof payload.category === "string" ? payload.category : undefined;
      const percent = typeof payload.percent === "number" ? payload.percent : undefined;
      const products_seen = typeof payload.products_seen === "number" ? payload.products_seen : undefined;
      const skipped = typeof payload.skipped === "boolean" ? payload.skipped : undefined;
      return {
        type: "progress",
        site: payload.site,
        category,
        percent,
        products_seen,
        skipped
      };
    }
    case "site_failed": {
      if (typeof payload.site !== "string" || !payload.site.trim() || typeof payload.error !== "string") return null;
      const category = typeof payload.category === "string" ? payload.category : undefined;
      return { type: "site_failed", site: payload.site, category, error: payload.error };
    }
    case "outcome": {
      if (typeof payload.outcome !== "object" || payload.outcome === null) return null;
      const outcome = payload.outcome as { status?: string };
      if (typeof outcome.status !== "string") return null;
      return { type: "outcome", outcome: payload.outcome as RunOutcome };
    }
    case "error": {
      const error = typeof payload.error === "string" ? payload.error : undefined;
      const status = typeof payload.status === "number" ? payload.status : undefined;
      return { type: "error", error, status };
    }
    default:
      return null;
  }
}

// Pure reducer: never mutates the incoming state (Maps are copied on write).
export function scrapeStreamReducer(state: ScrapeStreamState, action: ScrapeStreamAction): ScrapeStreamState {
  switch (action.type) {
    case "reset":
      return createInitialScrapeStreamState();

    case "log":
      if (typeof action.message !== "string") return state;
      return { ...state, logs: [...state.logs, action.message] };

    case "site_started": {
      if (!action.site || typeof action.site !== "string") return state;
      const key = rowKey(action.site, action.category);
      const rows = new Map(state.rows);
      rows.set(key, { key, site: action.site, category: action.category, status: "running", percent: 0 });
      return { ...state, rows };
    }

    case "progress": {
      if (!action.site || typeof action.site !== "string") return state;
      const key = rowKey(action.site, action.category);
      const rows = new Map(state.rows);
      const existing = rows.get(key);
      rows.set(key, {
        key,
        site: action.site,
        category: action.category,
        percent: action.percent ?? existing?.percent ?? 0,
        count: action.products_seen ?? existing?.count,
        status: action.skipped ? "skipped" : "running"
      });
      return { ...state, rows };
    }

    case "site_failed": {
      if (!action.site || typeof action.site !== "string" || typeof action.error !== "string") return state;
      const key = rowKey(action.site, action.category);
      const rows = new Map(state.rows);
      rows.set(key, { key, site: action.site, category: action.category, status: "failed", error: action.error });
      return { ...state, rows };
    }

    case "outcome": {
      const rows = new Map(state.rows);
      for (const [key, row] of rows) {
        if (row.status !== "running") continue;
        if (action.outcome.status === "succeeded" || action.outcome.status === "partial") {
          rows.set(key, { ...row, status: "done", percent: 100 });
        } else if (action.outcome.status === "cancelled") {
          rows.set(key, { ...row, status: "cancelled" });
        } else {
          rows.set(key, { ...row, status: "failed", error: "The scrape did not complete." });
        }
      }
      const runError =
        action.outcome.status === "partial"
          ? action.outcome.errors.join("\n") || "Some requested scrape jobs failed."
          : action.outcome.status === "failed"
            ? action.outcome.errors.join("\n") || "The scrape failed."
            : null;
      return {
        ...state,
        rows,
        productsWritten: action.outcome.products_written ?? undefined,
        runError,
        outcome: action.outcome
      };
    }

    case "error": {
      let runError: string;
      if (action.status === 409) runError = "A scrape is already running. Wait for it to finish.";
      else if (action.error === "python_unavailable") runError = "No Python interpreter available for scraping.";
      else runError = action.error ?? "The scrape failed.";
      return { ...state, runError };
    }

    default:
      return state;
  }
}
