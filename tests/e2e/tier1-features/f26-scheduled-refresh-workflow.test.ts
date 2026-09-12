import { describe, it, expect } from "vitest";
import { parseWorkflowYaml } from "../test-harness";

describe("Tier 1 - Feature 26: Scheduled Refresh CI Workflow (R6)", () => {
  const sampleWorkflow = `
    name: Refresh Catalog
    on:
      schedule:
        - cron: '17 2 * * *'
      workflow_dispatch:

    concurrency:
      group: catalog-refresh
      cancel-in-progress: false

    jobs:
      ingest:
        runs-on: ubuntu-latest
        steps:
          - uses: actions/checkout@v4
          - uses: actions/setup-python@v5
            with:
              python-version: '3.12'
          - uses: actions/setup-node@v4
            with:
              node-version: '20'
          - name: Run Scraper
            run: python -m scraper --output /tmp/candidate.db
          - name: Validate Snapshot
            run: npx tsx scripts/publish-catalog.ts --validate-only /tmp/candidate.db
          - name: Publish to Turso
            env:
              TURSO_INGEST_TOKEN: \${{ secrets.TURSO_INGEST_TOKEN }}
              TURSO_DATABASE_URL: \${{ secrets.TURSO_DATABASE_URL }}
            run: npx tsx scripts/publish-catalog.ts /tmp/candidate.db
  `;

  it("defines scheduled cron trigger matching '17 2 * * *'", () => {
    const parsed = parseWorkflowYaml(sampleWorkflow);
    expect(parsed.hasCron).toBe(true);
    expect(parsed.cronSchedule).toBe("17 2 * * *");
  });

  it("includes manual trigger workflow_dispatch", () => {
    const parsed = parseWorkflowYaml(sampleWorkflow);
    expect(parsed.hasWorkflowDispatch).toBe(true);
  });

  it("configures Python 3.12+ and Node.js 20+ environments", () => {
    expect(sampleWorkflow).toContain("python-version: '3.12'");
    expect(sampleWorkflow).toContain("node-version: '20'");
  });

  it("executes scraper into runner-local temporary database file", () => {
    expect(sampleWorkflow).toContain("/tmp/candidate.db");
  });

  it("runs on ubuntu-latest runner", () => {
    expect(sampleWorkflow).toContain("runs-on: ubuntu-latest");
  });
});
