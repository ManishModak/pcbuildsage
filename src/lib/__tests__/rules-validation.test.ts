import { describe, expect, it } from "vitest";
import { makeResolved, validateBuild } from "../rules-engine";
import { base, run } from "./rules-helpers";

describe("validateBuild orchestration", () => {
  it("passes a compatible build across all six rules", () => {
    expect(run().issues).toEqual([]);
    expect(run().valid).toBe(true);
  });
  it("passes socket, DDR, clearance, cooler, and storage edge boundaries", () => {
    const result = run({
      gpu: makeResolved("gpu-edge", "gpu", { ...base.gpu.spec, length_mm: 350 }),
      cooler: makeResolved("cooler-edge", "cooler", { ...base.cooler.spec, height_mm: 170, tdp_rating_w: 65 }),
      storage: [
        base.storage,
        makeResolved("ssd-nvme-2", "storage", { ...base.storage.spec, model: "SSD2" }),
        makeResolved("ssd-sata-1", "storage", { ...base.storage.spec, model: "SATA1", interface: "sata", form_factor: "2.5in" }),
        makeResolved("ssd-sata-2", "storage", { ...base.storage.spec, model: "SATA2", interface: "sata", form_factor: "2.5in" }),
        makeResolved("ssd-sata-3", "storage", { ...base.storage.spec, model: "SATA3", interface: "sata", form_factor: "2.5in" }),
        makeResolved("ssd-sata-4", "storage", { ...base.storage.spec, model: "SATA4", interface: "sata", form_factor: "2.5in" })
      ]
    });
    expect(result.issues).toEqual([]);
  });
  it("blocks arrays passed to single-component slots", () => {
    const result = validateBuild({ cpu: ["cpu-a", "cpu-b"] });
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "blocking", rule: "spec_resolution", detail: expect.stringContaining("single-component slot cpu") }));
  });
  it("reports the rules it could not run because a category has no part", () => {
    // Categories the user chose not to scrape are absent, not wrong - but the model
    // must know which guarantees it is therefore not making.
    const result = validateBuild(
      { cpu: base.cpu.key, gpu: base.gpu.key },
      { resolve: (part) => [base.cpu, base.gpu].find((item) => item.key === part) }
    );
    const skipped = Object.fromEntries(result.skipped_checks.map((check) => [check.rule, check.missing]));
    expect(skipped.wattage).toEqual(["psu"]);
    expect(skipped.socket).toEqual(["motherboard"]);
    expect(skipped.clearance).toEqual(["case"]);
    expect(skipped.display_output).toBeUndefined();
  });
  it("dedupes duplicate missing-spec issues for the same component", () => {
    const result = run({ cpu: makeResolved("cpu-no-socket", "cpu", { ...base.cpu.spec, socket: undefined }) });
    const socketIssues = result.issues.filter((issue) => issue.severity === "needs_research" && issue.detail.includes("\"socket\""));
    expect(socketIssues).toHaveLength(1);
  });
  it("matches sockets and form factors across formatting variants", () => {
    const result = run({
      cpu: makeResolved("cpu-lga1700", "cpu", { ...base.cpu.spec, socket: "LGA1700" }),
      motherboard: makeResolved("mobo-lga-1700", "motherboard", { ...base.motherboard.spec, socket: "LGA 1700", form_factor: "Mini ITX" }),
      case: makeResolved("case-mini-itx", "case", { ...base.case.spec, form_factors: ["Mini-ITX"] }),
      cooler: makeResolved("cooler-lga-1700", "cooler", { ...base.cooler.spec, sockets: ["LGA-1700"] })
    });
    expect(result.issues).not.toContainEqual(expect.objectContaining({ severity: "blocking", rule: "socket" }));
    expect(result.issues).not.toContainEqual(expect.objectContaining({ severity: "blocking", rule: "clearance" }));
    expect(result.issues).not.toContainEqual(expect.objectContaining({ severity: "blocking", rule: "cooler" }));
  });
  it("agrees with catalog matching on LGA_1700 sockets and mATX form factors", () => {
    const result = run({
      cpu: makeResolved("cpu-lga-1700", "cpu", { ...base.cpu.spec, socket: "LGA_1700" }),
      motherboard: makeResolved("mobo-matx", "motherboard", { ...base.motherboard.spec, socket: "LGA 1700", form_factor: "mATX" }),
      case: makeResolved("case-matx", "case", { ...base.case.spec, form_factors: ["Micro-ATX", "ATX"] }),
      cooler: makeResolved("cooler-lga_1700", "cooler", { ...base.cooler.spec, sockets: ["LGA_1700"] })
    });
    expect(result.issues).not.toContainEqual(expect.objectContaining({ severity: "blocking", rule: "socket" }));
    expect(result.issues).not.toContainEqual(expect.objectContaining({ severity: "blocking", rule: "clearance" }));
    expect(result.issues).not.toContainEqual(expect.objectContaining({ severity: "blocking", rule: "cooler" }));
  });
  it("marks unknown components unverified with needs_verification without duplicate research issues", () => {
    const unknown = validateBuild({ cpu: "missing", motherboard: "mobo-am5" }, { resolve: (part, category) => (part === "mobo-am5" && category === "motherboard" ? base.motherboard : undefined) });
    expect(unknown.issues).toContainEqual(expect.objectContaining({ severity: "needs_verification", rule: "spec_resolution" }));
    expect(unknown.issues).not.toContainEqual(expect.objectContaining({ severity: "needs_research", rule: "spec_resolution" }));
    // Exactly one spec_resolution issue
    const specIssues = unknown.issues.filter((i) => i.rule === "spec_resolution");
    expect(specIssues).toHaveLength(1);
  });
  it("downgrades passing rules with low-confidence researched specs to needs_verification", () => {
    const result = run({ cpu: makeResolved("cpu-researched", "cpu", base.cpu.spec, "low", "research") });
    expect(result.valid).toBe(true);
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "needs_verification" }));
  });
  it("does not report false display_output or wattage issues when GPU is specified but unresolved", () => {
    const cpu = makeResolved("cpu-no-igpu", "cpu", { ...base.cpu.spec, igpu: false, tdp_w: 125 });
    const psu = makeResolved("psu-500", "psu", { ...base.psu.spec, wattage: 500 });
    const result = validateBuild(
      { cpu: cpu.key, gpu: "unresolved-gpu", psu: psu.key },
      { resolve: (part) => (part === cpu.key ? cpu : part === psu.key ? psu : undefined) }
    );
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "needs_verification", rule: "spec_resolution" }));
    expect(result.issues).not.toContainEqual(expect.objectContaining({ severity: "needs_research", rule: "spec_resolution" }));
    expect(result.issues).not.toContainEqual(expect.objectContaining({ severity: "blocking", rule: "display_output" }));
    expect(result.issues).not.toContainEqual(expect.objectContaining({ severity: "blocking", rule: "wattage" }));
  });
  it("populates checks and summary correctly when all checks pass", () => {
    const result = run();
    expect(result.checks).toBeDefined();
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks.every((c) => c.status === "passed")).toBe(true);
    expect(result.summary).toEqual({
      passed: result.checks.length,
      failed: 0,
      unverified: 0,
      text: `All ${result.checks.length} checks passed`
    });
  });
  it("formats summary text correctly when checks fail or are unverified", () => {
    // 1 failure (GPU too long)
    const failResult = run({ gpu: makeResolved("gpu-long", "gpu", { ...base.gpu.spec, length_mm: 400 }) });
    expect(failResult.summary.failed).toBe(1);
    expect(failResult.summary.text).toContain("1 check(s) failed");

    // 1 unverified (case max GPU missing)
    const unverResult = run({ case: makeResolved("case-no-clearance", "case", { ...base.case.spec, max_gpu_length_mm: undefined }) });
    expect(unverResult.summary.unverified).toBe(1);
    expect(unverResult.summary.failed).toBe(0);
    expect(unverResult.summary.text).toMatch(/\d+ checks passed · 1 unverified/);
  });
  it("[r1] derives issues dynamically from non-passed checks and valid iff failed === 0", () => {
    // Unresolved part produces unverified check and needs_verification issue, but valid remains true
    const result = validateBuild(
      { cpu: "non-existent-cpu" },
      { resolve: () => undefined }
    );
    expect(result.valid).toBe(true);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.unverified).toBe(1);

    const check = result.checks.find((c) => c.rule === "spec_resolution");
    expect(check).toBeDefined();
    expect(check?.status).toBe("unverified");
    expect(check?.components).toContain("non-existent-cpu");

    const issue = result.issues.find((i) => i.rule === "spec_resolution" && i.severity === "needs_verification");
    expect(issue).toBeDefined();
    expect(issue?.detail).toBe(check?.message);
  });
  it("null-safely handles null/undefined parts in isMarkedIncluded", () => {
    const result = validateBuild(
      { cpu: base.cpu.key, cooler: null as unknown as undefined },
      { resolve: (part) => (part === base.cpu.key ? base.cpu : undefined) }
    );
    expect(result).toBeDefined();
  });
});
