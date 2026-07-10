import type { ScrapeEvent } from "../lib/types";
import type { SiteRow } from "./scrape-progress";

// State for a single scrape run's SSE stream. Kept in one reducer so every
// server event applies atomically instead of fanning out across setters.
export type ScrapeStreamState = {
  rows: Map<string, SiteRow>;
  logs: string[];
  productsWritten: number | undefined;
  runError: string | null;
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
  | { type: "done"; products_written?: number }
  | { type: "error"; error?: string; status?: number }
  | { type: "stream_failed"; message: string };

export function createInitialScrapeStreamState(): ScrapeStreamState {
  return { rows: new Map(), logs: [], productsWritten: undefined, runError: null };
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
  const type = (data as { type?: string }).type ?? event;
  const payload = data as ScrapeEvent;

  switch (type) {
    case "log":
      return { type: "log", message: (payload as { message: string }).message };
    case "site_started": {
      const d = payload as { site: string; category?: string };
      return { type: "site_started", site: d.site, category: d.category };
    }
    case "progress": {
      const d = payload as {
        site: string;
        category?: string;
        percent?: number;
        products_seen?: number;
        skipped?: boolean;
      };
      return {
        type: "progress",
        site: d.site,
        category: d.category,
        percent: d.percent,
        products_seen: d.products_seen,
        skipped: d.skipped
      };
    }
    case "site_failed": {
      const d = payload as { site: string; category?: string; error: string };
      return { type: "site_failed", site: d.site, category: d.category, error: d.error };
    }
    case "done":
      return { type: "done", products_written: (payload as { products_written?: number }).products_written };
    case "error": {
      const d = payload as { error?: string; status?: number };
      return { type: "error", error: d.error, status: d.status };
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
      return { ...state, logs: [...state.logs, action.message] };

    case "site_started": {
      const key = rowKey(action.site, action.category);
      const rows = new Map(state.rows);
      rows.set(key, { key, site: action.site, category: action.category, status: "running", percent: 0 });
      return { ...state, rows };
    }

    case "progress": {
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
      const key = rowKey(action.site, action.category);
      const rows = new Map(state.rows);
      rows.set(key, { key, site: action.site, category: action.category, status: "failed", error: action.error });
      return { ...state, rows };
    }

    case "done": {
      const rows = new Map(state.rows);
      for (const [key, row] of rows) {
        if (row.status === "running") rows.set(key, { ...row, status: "done", percent: 100 });
      }
      return { ...state, rows, productsWritten: action.products_written };
    }

    case "error": {
      let runError: string;
      if (action.status === 409) runError = "A scrape is already running. Wait for it to finish.";
      else if (action.error === "python_unavailable") runError = "No Python interpreter available for scraping.";
      else runError = action.error ?? "The scrape failed.";
      return { ...state, runError };
    }

    case "stream_failed":
      return { ...state, runError: action.message };

    default:
      return state;
  }
}
