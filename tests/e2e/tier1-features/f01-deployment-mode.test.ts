import { describe, it, expect } from "vitest";
import { resolveDeploymentMode, isHostedDemoMode, simulateDeploymentEnv } from "../test-harness";

describe("Tier 1 - Feature 1: Deployment Mode Configuration (R1)", () => {
  it("defaults to 'local' when PCBUILDSAGE_DEPLOYMENT_MODE is unset", () => {
    simulateDeploymentEnv(undefined, () => {
      expect(resolveDeploymentMode()).toBe("local");
      expect(isHostedDemoMode()).toBe(false);
    });
  });

  it("resolves to 'hosted-demo' when PCBUILDSAGE_DEPLOYMENT_MODE='hosted-demo'", () => {
    simulateDeploymentEnv("hosted-demo", () => {
      expect(resolveDeploymentMode()).toBe("hosted-demo");
      expect(isHostedDemoMode()).toBe(true);
    });
  });

  it("resolves to 'local' when PCBUILDSAGE_DEPLOYMENT_MODE='local'", () => {
    simulateDeploymentEnv("local", () => {
      expect(resolveDeploymentMode()).toBe("local");
      expect(isHostedDemoMode()).toBe(false);
    });
  });

  it("handles whitespace trimming and case insensitivity safely", () => {
    expect(resolveDeploymentMode("  hosted-demo  ")).toBe("hosted-demo");
    expect(resolveDeploymentMode("HOSTED-DEMO")).toBe("hosted-demo");
    expect(resolveDeploymentMode("  Hosted-Demo  ")).toBe("hosted-demo");
    expect(resolveDeploymentMode("LOCAL")).toBe("local");
    expect(resolveDeploymentMode("  local ")).toBe("local");
  });

  it("falls back safely to 'local' when an unrecognized mode is provided", () => {
    expect(resolveDeploymentMode("staging")).toBe("local");
    expect(resolveDeploymentMode("production")).toBe("local");
    expect(resolveDeploymentMode("invalid-mode-123")).toBe("local");
    expect(resolveDeploymentMode("")).toBe("local");
  });

  it("isHostedDemoMode accurately reflects current resolved mode", () => {
    expect(isHostedDemoMode("hosted-demo")).toBe(true);
    expect(isHostedDemoMode("local")).toBe(false);
    expect(isHostedDemoMode("unknown")).toBe(false);
  });
});
