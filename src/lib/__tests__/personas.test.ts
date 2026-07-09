import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPersonalities, resetPersonalityCache } from "../personalities";
import { loadPersonas, resetPersonaCache } from "../personas";

let tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs) rmSync(tempDir, { recursive: true, force: true });
  tempDirs = [];
  resetPersonaCache();
  resetPersonalityCache();
});

function makeDir() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "pcbuildsage-personas-"));
  tempDirs.push(tempDir);
  return tempDir;
}

describe("persona and personality caches", () => {
  it("reuses loaded personas until the cache is reset", () => {
    const dir = makeDir();
    const file = path.join(dir, "balanced.json");
    writeFileSync(file, JSON.stringify({
      $schema: "schema",
      persona_name: "Balanced",
      description: "Balanced buyer",
      budget_weights: { cpu: 1 },
      priorities: ["value"],
      tone: "concise"
    }), "utf8");

    expect(loadPersonas(dir).map((persona) => persona.persona_name)).toEqual(["Balanced"]);
    writeFileSync(file, JSON.stringify({
      $schema: "schema",
      persona_name: "Changed",
      description: "Changed buyer",
      budget_weights: { cpu: 1 },
      priorities: ["value"],
      tone: "concise"
    }), "utf8");
    expect(loadPersonas(dir).map((persona) => persona.persona_name)).toEqual(["Balanced"]);
    resetPersonaCache();
    expect(loadPersonas(dir).map((persona) => persona.persona_name)).toEqual(["Changed"]);
  });

  it("keeps persona caches separate for custom directories", () => {
    const first = makeDir();
    const second = makeDir();
    writeFileSync(path.join(first, "balanced.json"), JSON.stringify({
      $schema: "schema",
      persona_name: "First",
      description: "First buyer",
      budget_weights: { cpu: 1 },
      priorities: ["value"],
      tone: "concise"
    }), "utf8");
    writeFileSync(path.join(second, "balanced.json"), JSON.stringify({
      $schema: "schema",
      persona_name: "Second",
      description: "Second buyer",
      budget_weights: { cpu: 1 },
      priorities: ["quiet"],
      tone: "direct"
    }), "utf8");

    expect(loadPersonas(first).map((persona) => persona.persona_name)).toEqual(["First"]);
    expect(loadPersonas(second).map((persona) => persona.persona_name)).toEqual(["Second"]);
  });

  it("skips invalid personas and still loads valid files", () => {
    const dir = makeDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    writeFileSync(path.join(dir, "bad.json"), "{ malformed", "utf8");
    writeFileSync(path.join(dir, "balanced.json"), JSON.stringify({
      $schema: "schema",
      persona_name: "Balanced",
      description: "Balanced buyer",
      budget_weights: { cpu: 1 },
      priorities: ["value"],
      tone: "concise"
    }), "utf8");

    expect(loadPersonas(dir).map((persona) => persona.persona_name)).toEqual(["Balanced"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bad.json"));
  });

  it("reuses loaded personalities until the cache is reset", () => {
    const dir = makeDir();
    const file = path.join(dir, "direct.json");
    writeFileSync(file, JSON.stringify({
      name: "Direct",
      description: "Direct style",
      prompt: "Be direct."
    }), "utf8");

    expect(loadPersonalities(dir).map((personality) => personality.name)).toEqual(["Direct"]);
    writeFileSync(file, JSON.stringify({
      name: "Changed",
      description: "Changed style",
      prompt: "Changed."
    }), "utf8");
    expect(loadPersonalities(dir).map((personality) => personality.name)).toEqual(["Direct"]);
    resetPersonalityCache();
    expect(loadPersonalities(dir).map((personality) => personality.name)).toEqual(["Changed"]);
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

    expect(loadPersonalities(first).map((personality) => personality.name)).toEqual(["First"]);
    expect(loadPersonalities(second).map((personality) => personality.name)).toEqual(["Second"]);
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

    expect(loadPersonalities(dir).map((personality) => personality.name)).toEqual(["Direct"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bad.json"));
  });
});
