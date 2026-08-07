import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPersonalities, resetPersonalityCache } from "@/lib/llm/personalities";

let tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs) rmSync(tempDir, { recursive: true, force: true });
  tempDirs = [];
  resetPersonalityCache();
});

function makeDir() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "pcbuildsage-personalities-"));
  tempDirs.push(tempDir);
  return tempDir;
}

describe("personality cache", () => {
  it("reuses loaded personalities until the cache is reset", () => {
    const dir = makeDir();
    const file = path.join(dir, "direct.json");
    writeFileSync(file, JSON.stringify({
      name: "Direct",
      description: "Direct style",
      prompt: "Be direct."
    }), "utf8");

    expect(loadPersonalities(dir).map((personality: { name: string }) => personality.name)).toEqual(["Direct"]);
    writeFileSync(file, JSON.stringify({
      name: "Changed",
      description: "Changed style",
      prompt: "Changed."
    }), "utf8");
    expect(loadPersonalities(dir).map((personality: { name: string }) => personality.name)).toEqual(["Direct"]);
    resetPersonalityCache();
    expect(loadPersonalities(dir).map((personality: { name: string }) => personality.name)).toEqual(["Changed"]);
  });

  it("keeps personality caches separate for custom directories", () => {
    const first = makeDir();
    const second = makeDir();
    writeFileSync(path.join(first, "direct.json"), JSON.stringify({
      name: "First",
      description: "First style",
      prompt: "First."
    }), "utf8");
    writeFileSync(path.join(second, "direct.json"), JSON.stringify({
      name: "Second",
      description: "Second style",
      prompt: "Second."
    }), "utf8");

    expect(loadPersonalities(first).map((personality: { name: string }) => personality.name)).toEqual(["First"]);
    expect(loadPersonalities(second).map((personality: { name: string }) => personality.name)).toEqual(["Second"]);
  });

  it("skips invalid personalities and still loads valid files", () => {
    const dir = makeDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    writeFileSync(path.join(dir, "bad.json"), JSON.stringify({ name: "Bad" }), "utf8");
    writeFileSync(path.join(dir, "direct.json"), JSON.stringify({
      name: "Direct",
      description: "Direct style",
      prompt: "Be direct."
    }), "utf8");

    expect(loadPersonalities(dir).map((personality: { name: string }) => personality.name)).toEqual(["Direct"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bad.json"));
  });
});
