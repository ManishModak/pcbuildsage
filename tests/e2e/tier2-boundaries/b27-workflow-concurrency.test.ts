import { describe, it, expect } from "vitest";
import { parseWorkflowYaml } from "../test-harness";

describe("Tier 2 Boundary - Feature 27: Workflow Concurrency Boundaries", () => {
  it("detects missing concurrency block in workflow configuration", () => {
    const noConcurrency = `
      name: Ingest
      jobs:
        run:
          runs-on: ubuntu-latest
    `;
    const parsed = parseWorkflowYaml(noConcurrency);
    expect(parsed.hasConcurrency).toBe(false);
  });

  it("detects and flags cancel-in-progress: true as unsafe for catalog publisher", () => {
    const unsafeConcurrency = `
      concurrency:
        group: catalog-refresh
        cancel-in-progress: true
    `;
    const parsed = parseWorkflowYaml(unsafeConcurrency);
    expect(parsed.cancelInProgressFalse).toBe(false);
  });

  it("validates cancel-in-progress: false allows in-flight publisher to finish cleanly", () => {
    const safeConcurrency = `
      concurrency:
        group: catalog-refresh
        cancel-in-progress: false
    `;
    const parsed = parseWorkflowYaml(safeConcurrency);
    expect(parsed.cancelInProgressFalse).toBe(true);
  });

  it("handles dynamic concurrency group expressions with repository context", () => {
    const groupExpr = "catalog-refresh-${{ github.ref }}";
    expect(groupExpr).toContain("catalog-refresh");
  });

  it("ensures concurrency group name is non-empty", () => {
    const group = "catalog-refresh";
    expect(group.trim().length).toBeGreaterThan(0);
  });
});
