import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

/**
 * Resolve path to .github/workflows/refresh-catalog.yml supporting
 * execution from either repository root or workspace root.
 */
function getWorkflowPath(): string {
  const candidatePaths = [
    path.resolve(process.cwd(), ".github/workflows/refresh-catalog.yml"),
    path.resolve(__dirname, "../../.github/workflows/refresh-catalog.yml"),
    path.resolve(process.cwd(), "pcbuildsage/.github/workflows/refresh-catalog.yml"),
  ];

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Workflow file .github/workflows/refresh-catalog.yml not found. Checked: ${candidatePaths.join(", ")}`
  );
}

type WorkflowStep = {
  uses?: string;
  name?: string;
  run?: string;
  env?: Record<string, string | undefined>;
  with?: Record<string, unknown>;
};

type WorkflowFile = {
  name: string;
  on: { schedule: Array<{ cron: string }>; workflow_dispatch: unknown };
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: { refresh: { "runs-on": string; "timeout-minutes": number; steps: WorkflowStep[] } };
};

describe("GitHub Actions Workflow: Refresh Hosted Catalog (.github/workflows/refresh-catalog.yml)", () => {
  const workflowPath = getWorkflowPath();
  const rawContent = fs.readFileSync(workflowPath, "utf-8");
  const parsedWorkflow = yaml.load(rawContent) as unknown as WorkflowFile;

  it("exists on disk at .github/workflows/refresh-catalog.yml", () => {
    expect(fs.existsSync(workflowPath)).toBe(true);
    expect(rawContent.length).toBeGreaterThan(0);
  });

  it("defines workflow name as 'Refresh hosted catalog'", () => {
    expect(parsedWorkflow.name).toBe("Refresh hosted catalog");
  });

  describe("Triggers & Schedule", () => {
    it("configures scheduled cron trigger matching '17 2 * * *'", () => {
      expect(parsedWorkflow.on).toBeDefined();
      expect(parsedWorkflow.on.schedule).toBeInstanceOf(Array);
      expect(parsedWorkflow.on.schedule.length).toBeGreaterThanOrEqual(1);

      const cronEntry = parsedWorkflow.on.schedule.find(
        (s: { cron?: string }) => s.cron === "17 2 * * *"
      );
      expect(cronEntry).toBeDefined();
      expect(cronEntry!.cron).toBe("17 2 * * *");
    });

    it("includes manual trigger workflow_dispatch", () => {
      expect(parsedWorkflow.on).toHaveProperty("workflow_dispatch");
    });
  });

  describe("Concurrency Serialization", () => {
    it("defines concurrency group 'hosted-catalog-publish'", () => {
      expect(parsedWorkflow.concurrency).toBeDefined();
      expect(parsedWorkflow.concurrency.group).toBe("hosted-catalog-publish");
    });

    it("sets cancel-in-progress to false to prevent terminating in-flight catalog writes", () => {
      expect(parsedWorkflow.concurrency["cancel-in-progress"]).toBe(false);
    });
  });

  describe("Job Configuration: refresh", () => {
    const job = parsedWorkflow.jobs.refresh;

    it("defines job named 'refresh'", () => {
      expect(job).toBeDefined();
    });

    it("targets runner 'ubuntu-latest'", () => {
      expect(job["runs-on"]).toBe("ubuntu-latest");
    });

    it("enforces 90 minute execution timeout", () => {
      expect(job["timeout-minutes"]).toBe(90);
    });

    it("contains expected sequence of workflow steps", () => {
      expect(Array.isArray(job.steps)).toBe(true);
      expect(job.steps.length).toBeGreaterThanOrEqual(6);
    });
  });

  describe("Workflow Steps", () => {
    const steps: WorkflowStep[] = parsedWorkflow.jobs.refresh.steps ?? [];

    it("checks out repository using actions/checkout@v4", () => {
      const checkoutStep = steps.find((s) => s.uses?.startsWith("actions/checkout"));
      expect(checkoutStep).toBeDefined();
      expect(checkoutStep!.uses).toBe("actions/checkout@v4");
    });

    it("configures Python 3.11 with pip caching using actions/setup-python@v5", () => {
      const pythonStep = steps.find((s) => s.uses?.startsWith("actions/setup-python"));
      expect(pythonStep).toBeDefined();
      expect(pythonStep!.uses).toBe("actions/setup-python@v5");
      expect(String(pythonStep!.with?.["python-version"])).toBe("3.11");
      expect(pythonStep!.with?.cache).toBe("pip");
    });

    it("configures Node.js 20 with npm caching using actions/setup-node@v4", () => {
      const nodeStep = steps.find((s) => s.uses?.startsWith("actions/setup-node"));
      expect(nodeStep).toBeDefined();
      expect(nodeStep!.uses).toBe("actions/setup-node@v4");
      expect(String(nodeStep!.with?.["node-version"])).toBe("20");
      expect(nodeStep!.with?.cache).toBe("npm");
    });

    it("installs node dependencies, scraper requirements, and Playwright Chromium", () => {
      const installStep = steps.find(
        (s) => s.name?.includes("dependencies") || s.run?.includes("pip install")
      );
      expect(installStep).toBeDefined();
      expect(installStep!.run).toContain("npm ci");
      expect(installStep!.run).toContain("pip install -r scraper/requirements.txt");
      expect(installStep!.run).toContain("playwright install chromium --with-deps");
    });

    it("builds candidate catalog locally into runner-local temp database ($RUNNER_TEMP/catalog.db)", () => {
      const buildStep = steps.find(
        (s) => s.name?.includes("candidate catalog") || s.run?.includes("python -m scraper")
      );
      expect(buildStep).toBeDefined();
      expect(buildStep!.run).toContain("python -m scraper");
      expect(buildStep!.run).toContain('--profile india');
      expect(buildStep!.run).toContain('--db "$RUNNER_TEMP/catalog.db"');
      expect(buildStep!.run).toContain("--skip-fresh 20");
      expect(buildStep!.run).toContain("--concurrency 2");
      expect(buildStep!.run).toContain("--delay-ms 1000");
    });

    it("validates and publishes accepted snapshot via npm run publish-catalog with Turso credentials", () => {
      const publishStep = steps.find(
        (s) => s.name?.includes("publish") || s.run?.includes("publish-catalog")
      );
      expect(publishStep).toBeDefined();

      // Verify command execution with target temp db path
      expect(publishStep!.run).toContain('npm run publish-catalog -- --db "$RUNNER_TEMP/catalog.db"');

      // Verify Turso secrets injection
      expect(publishStep!.env).toBeDefined();
      expect(publishStep!.env?.TURSO_DATABASE_URL).toBe("${{ secrets.TURSO_DATABASE_URL }}");
      expect(publishStep!.env?.TURSO_INGEST_TOKEN).toBe("${{ secrets.TURSO_INGEST_TOKEN }}");

      // Verify security boundary: read token or unauthorized keys are not injected
      expect(publishStep!.env?.TURSO_READ_TOKEN).toBeUndefined();
    });
  });
});
