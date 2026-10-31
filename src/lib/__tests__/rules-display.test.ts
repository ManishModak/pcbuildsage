import { describe, expect, it } from "vitest";
import { makeResolved, validateBuild } from "../rules-engine";
import { base } from "./rules-helpers";

describe("rule: display_output", () => {
  it("blocks CPU-only builds when the CPU has no integrated GPU", () => {
    const cpu = makeResolved("cpu-no-igpu", "cpu", { ...base.cpu.spec, igpu: false });
    const result = validateBuild({ cpu: cpu.key }, { resolve: (part) => (part === cpu.key ? cpu : undefined) });
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "blocking", rule: "display_output", detail: expect.stringContaining("no display output") }));
  });
  it("requests research for CPU-only builds when integrated GPU status is unknown", () => {
    const cpu = makeResolved("cpu-unknown-igpu", "cpu", { ...base.cpu.spec, igpu: undefined });
    const result = validateBuild({ cpu: cpu.key }, { resolve: (part) => (part === cpu.key ? cpu : undefined) });
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "needs_research", detail: expect.stringContaining("\"igpu\"") }));
  });
  it("records the discrete GPU key in components for display output when GPU is present", () => {
    const cpu = makeResolved("cpu-7600", "cpu", { ...base.cpu.spec, igpu: true });
    const gpu = makeResolved("gpu-4070", "gpu", base.gpu.spec);
    const result = validateBuild(
      { cpu: cpu.key, gpu: gpu.key },
      { resolve: (part) => (part === cpu.key ? cpu : part === gpu.key ? gpu : undefined) }
    );
    const displayCheck = result.checks.find((c) => c.rule === "display_output");
    expect(displayCheck?.status).toBe("passed");
    expect(displayCheck?.components).toEqual([gpu.key]);
  });
});
