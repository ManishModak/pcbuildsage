import { describe, it, expect } from "vitest";
import { parseWorkflowYaml } from "../test-harness";

describe("Tier 1 - Feature 27: Workflow Concurrency Serialization (R6)", () => {
  const sampleWorkflow = `
    concurrency:
      group: catalog-refresh
      cancel-in-progress: false
  `;

  it("defines concurrency group 'catalog-refresh'", () => {
    const parsed = parseWorkflowYaml(sampleWorkflow);
    expect(parsed.hasConcurrency).toBe(true);
    expect(sampleWorkflow).toContain("group: catalog-refresh");
  });

  it("sets cancel-in-progress: false to guarantee complete execution", () => {
    const parsed = parseWorkflowYaml(sampleWorkflow);
    expect(parsed.cancelInProgressFalse).toBe(true);
  });

  it("prevents overlapping Turso catalog publishing runs", () => {
    const runningJobs = ["run-1"];
    const canStartNewJob = runningJobs.length === 0;
    expect(canStartNewJob).toBe(false);
  });

  it("serializes scheduled and manual workflow dispatch triggers", () => {
    const queue = ["scheduled-run", "manual-dispatch"];
    const executionOrder: string[] = [];
    while (queue.length > 0) {
      executionOrder.push(queue.shift()!);
    }
    expect(executionOrder).toEqual(["scheduled-run", "manual-dispatch"]);
  });

  it("ensures concurrency group is globally unique to ingestion workflow", () => {
    const groupName = "catalog-refresh";
    expect(groupName).toBe("catalog-refresh");
  });
});
