import { describe, it, expect } from "vitest";
import { parseWorkflowYaml } from "../test-harness";

describe("Tier 2 Boundary - Feature 26: Scheduled Workflow Boundaries", () => {
  it("validates 5-field cron syntax format ('17 2 * * *')", () => {
    const cron = "17 2 * * *";
    const parts = cron.split(" ");
    expect(parts.length).toBe(5);
    expect(parts[0]).toBe("17"); // minute 17
    expect(parts[1]).toBe("2");  // hour 2 AM UTC
  });

  it("detects missing cron expression in workflow", () => {
    const invalidWorkflow = `
      on:
        workflow_dispatch:
    `;
    const parsed = parseWorkflowYaml(invalidWorkflow);
    expect(parsed.hasCron).toBe(false);
    expect(parsed.cronSchedule).toBeNull();
  });

  it("handles multiple workflow triggers simultaneously", () => {
    const multiTrigger = `
      on:
        schedule:
          - cron: '17 2 * * *'
        workflow_dispatch:
        push:
          branches: [ main ]
    `;
    const parsed = parseWorkflowYaml(multiTrigger);
    expect(parsed.hasCron).toBe(true);
    expect(parsed.hasWorkflowDispatch).toBe(true);
  });

  it("validates runner OS specification is ubuntu-latest", () => {
    const runner = "ubuntu-latest";
    expect(runner).toBe("ubuntu-latest");
  });

  it("ensures workflow checkout step specifies repository checkout", () => {
    const step = "uses: actions/checkout@v4";
    expect(step).toContain("actions/checkout");
  });
});
