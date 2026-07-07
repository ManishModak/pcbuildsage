import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEndpointPresets } from "../endpoints";
import { loadSearchPresets } from "../web-search";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  vi.restoreAllMocks();
});

function makeDir() {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pcbuildsage-presets-"));
  return tempDir;
}

describe("preset loading", () => {
  it("skips malformed endpoint presets and still returns valid files", () => {
    const dir = makeDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    writeFileSync(path.join(dir, "bad.json"), "{ malformed", "utf8");
    writeFileSync(path.join(dir, "good.json"), JSON.stringify({
      name: "Local",
      provider_class: "openai-compatible",
      base_url: "http://localhost:11434/v1",
      requires_key: false,
      model_list_style: "openai"
    }), "utf8");

    expect(loadEndpointPresets(dir)).toEqual([expect.objectContaining({ name: "Local" })]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bad.json"));
  });

  it("returns no endpoint presets when the directory is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(loadEndpointPresets(path.join(os.tmpdir(), "pcbuildsage-missing-endpoints"))).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Skipping endpoint presets"));
  });

  it("skips malformed search presets and still returns valid files", () => {
    const dir = makeDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    writeFileSync(path.join(dir, "bad.json"), JSON.stringify({ name: "Bad" }), "utf8");
    writeFileSync(path.join(dir, "good.json"), JSON.stringify({
      name: "DuckDuckGo",
      provider: "duckduckgo",
      requires_key: false
    }), "utf8");

    expect(loadSearchPresets(dir)).toEqual([expect.objectContaining({ name: "DuckDuckGo" })]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bad.json"));
  });

  it("returns no search presets when the directory is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(loadSearchPresets(path.join(os.tmpdir(), "pcbuildsage-missing-search"))).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Skipping search presets"));
  });
});
