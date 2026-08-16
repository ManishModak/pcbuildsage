import { describe, expect, it } from "vitest";
import {
  createInitialScrapeStreamState,
  scrapeStreamReducer,
  toScrapeStreamAction
} from "../scrape-stream-reducer";
import type { RunOutcome } from "@/contracts/scrape";

describe("scrape stream terminal state", () => {
  it.each([
    ["succeeded", true, null],
    ["partial", false, "one failed"],
    ["failed", false, "one failed"],
    ["cancelled", false, null]
  ] as const)("models %s as an explicit outcome", (status, canContinue, expectedError) => {
    const initial = scrapeStreamReducer(createInitialScrapeStreamState(), {
      type: "site_started",
      site: "shop",
      category: "gpu"
    });
    const outcome: RunOutcome = {
      status,
      jobs_total: 1,
      jobs_succeeded: status === "succeeded" ? 1 : 0,
      jobs_failed: status === "partial" || status === "failed" ? 1 : 0,
      jobs_skipped: 0,
      products_written: status === "succeeded" ? 4 : null,
      errors: expectedError ? [expectedError] : []
    };

    const state = scrapeStreamReducer(initial, { type: "outcome", outcome });

    expect(state.outcome?.status === "succeeded").toBe(canContinue);
    expect(state.runError).toBe(expectedError);
    expect(state.outcome).toEqual(outcome);
  });
});

describe("toScrapeStreamAction runtime validation", () => {
  it("rejects non-object or null data", () => {
    expect(toScrapeStreamAction("log", null)).toBeNull();
    expect(toScrapeStreamAction("log", undefined)).toBeNull();
    expect(toScrapeStreamAction("log", "just string")).toBeNull();
    expect(toScrapeStreamAction("log", 123)).toBeNull();
  });

  it("validates log payloads", () => {
    expect(toScrapeStreamAction("log", { message: "valid message" })).toEqual({
      type: "log",
      message: "valid message"
    });
    expect(toScrapeStreamAction("log", {})).toBeNull();
    expect(toScrapeStreamAction("log", { message: 123 })).toBeNull();
  });

  it("validates site_started payloads", () => {
    expect(toScrapeStreamAction("site_started", { site: "shop", category: "gpu" })).toEqual({
      type: "site_started",
      site: "shop",
      category: "gpu"
    });
    expect(toScrapeStreamAction("site_started", { site: "" })).toBeNull();
    expect(toScrapeStreamAction("site_started", {})).toBeNull();
  });

  it("validates progress payloads", () => {
    expect(toScrapeStreamAction("progress", { site: "shop", percent: 50, products_seen: 10 })).toEqual({
      type: "progress",
      site: "shop",
      category: undefined,
      percent: 50,
      products_seen: 10,
      skipped: undefined
    });
    expect(toScrapeStreamAction("progress", { site: "   " })).toBeNull();
    expect(toScrapeStreamAction("progress", {})).toBeNull();
  });

  it("validates site_failed payloads", () => {
    expect(toScrapeStreamAction("site_failed", { site: "shop", error: "network error" })).toEqual({
      type: "site_failed",
      site: "shop",
      category: undefined,
      error: "network error"
    });
    expect(toScrapeStreamAction("site_failed", { site: "shop" })).toBeNull();
    expect(toScrapeStreamAction("site_failed", { error: "failed" })).toBeNull();
  });
});
