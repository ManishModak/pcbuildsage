import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { askTurnError, createAskTurnCollector } from "../ask-turn";
import { loadEnvFileIfPresent } from "../env";

describe("ask turn outcome", () => {
  it("reports an empty turn as an error with the step count", () => {
    const collector = createAskTurnCollector();
    for (let i = 0; i < 25; i += 1) collector.observe({ type: "finish-step" });
    const turn = collector.result();
    expect(turn).toMatchObject({ content: "", steps: 25, builds: [] });
    expect(askTurnError(turn)).toBe("The model ended the turn without an answer after 25 steps.");
  });

  it("names the provider error when the stream failed", () => {
    const collector = createAskTurnCollector();
    collector.observe({ type: "error", error: new Error("401 No cookie auth credentials found") });
    expect(askTurnError(collector.result())).toBe("The turn failed after 0 steps: 401 No cookie auth credentials found");
  });

  it("treats a presented build with no text as success and attaches its validated snapshot", () => {
    const snapshot = { label: "Within budget", total: 59000, currency: "INR", components: [] };
    const collector = createAskTurnCollector();
    collector.observe({ type: "tool-result", toolName: "validate_build", output: { builds: { "Within budget": { valid: true, snapshot } } } });
    collector.observe({ type: "tool-result", toolName: "present_build", output: { presented: false, error: "nope", builds: [] } });
    collector.observe({
      type: "tool-result",
      toolName: "present_build",
      output: { presented: true, builds: [{ label: "within budget", product_ids: ["abcdef1234"] }] }
    });
    const turn = collector.result();
    expect(askTurnError(turn)).toBeUndefined();
    expect(turn.builds).toEqual([{ label: "within budget", product_ids: ["abcdef1234"], snapshot }]);
  });

  it("counts text as an answer", () => {
    const collector = createAskTurnCollector();
    collector.observe({ type: "text-delta", text: "Here are two options." });
    expect(askTurnError(collector.result())).toBeUndefined();
  });
});

describe("CLI .env loading", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    delete process.env.PCBS_TEST_FROM_FILE;
    delete process.env.PCBS_TEST_SHELL;
  });

  it("loads missing vars without overriding ones the shell set", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pcbs-env-"));
    dirs.push(dir);
    const file = path.join(dir, ".env");
    writeFileSync(file, "PCBS_TEST_FROM_FILE=file\nPCBS_TEST_SHELL=file\n");
    process.env.PCBS_TEST_SHELL = "shell";
    expect(loadEnvFileIfPresent(file)).toBe(true);
    expect(process.env.PCBS_TEST_FROM_FILE).toBe("file");
    expect(process.env.PCBS_TEST_SHELL).toBe("shell");
  });

  it("ignores a missing file", () => {
    expect(loadEnvFileIfPresent(path.join(os.tmpdir(), "pcbs-no-such-dir", ".env"))).toBe(false);
  });
});
