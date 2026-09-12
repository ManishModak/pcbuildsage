import { describe, it, expect } from "vitest";
import { resolveDeploymentMode } from "../test-harness";

describe("Tier 2 Boundary - Feature 1: Deployment Mode Boundaries", () => {
  it("handles empty string by defaulting safely to 'local'", () => {
    expect(resolveDeploymentMode("")).toBe("local");
  });

  it("handles whitespace-only string by defaulting safely to 'local'", () => {
    expect(resolveDeploymentMode("    ")).toBe("local");
    expect(resolveDeploymentMode("\t\n\r")).toBe("local");
  });

  it("handles mixed case with unexpected characters (e.g. 'hosted_demo', 'HOSTED-DEMO!') safely", () => {
    expect(resolveDeploymentMode("hosted_demo")).toBe("local");
    expect(resolveDeploymentMode("HOSTED-DEMO!")).toBe("local");
  });

  it("handles Unicode and control character injections safely", () => {
    expect(resolveDeploymentMode("hosted-demo\u0000")).toBe("local");
    expect(resolveDeploymentMode("hosted\u200B-demo")).toBe("local");
    expect(resolveDeploymentMode("hоsted-demo")).toBe("local"); // Cyrillic homoglyph
  });

  it("handles undefined or null inputs predictably", () => {
    expect(resolveDeploymentMode(undefined)).toBe("local");
    expect(resolveDeploymentMode(null as unknown as string)).toBe("local");
  });
});
