import { describe, expect, it } from "vitest";
import { parseRunOutcome, resolveRunTermination } from "../scrape";

// Shape emitted by summarize_run in scraper/__main__.py for one partial job.
const lonePartial = {
  status: "partial",
  jobs_total: 1,
  jobs_succeeded: 0,
  jobs_failed: 0,
  jobs_skipped: 0,
  jobs_partial: 1,
  products_written: 12,
  errors: ["Shop/gpu: partial crawl"]
};

describe("scrape run outcome contract", () => {
  it("accepts a partial run reported apart from hard failures", () => {
    expect(parseRunOutcome({ type: "outcome", outcome: lonePartial })).toEqual(lonePartial);
  });

  it("rejects partial job counts that do not add up", () => {
    expect(parseRunOutcome({ ...lonePartial, jobs_partial: 2 })).toBeNull();
    expect(parseRunOutcome({ ...lonePartial, status: "succeeded" })).toBeNull();
  });

  it("matches the scraper's exit code: partial with rows exits 0, without rows exits 1", () => {
    const partial = parseRunOutcome(lonePartial)!;
    expect(resolveRunTermination([partial], 0, null)).toEqual(partial);
    expect(resolveRunTermination([partial], 1, null)).toMatchObject({ status: "failed", jobs_total: 0 });

    const empty = { ...partial, products_written: 0 };
    expect(resolveRunTermination([empty], 1, null)).toEqual(empty);
    expect(resolveRunTermination([empty], 0, null)).toMatchObject({ status: "failed", jobs_total: 0 });
  });
});
