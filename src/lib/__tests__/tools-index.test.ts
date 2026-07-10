import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config";
import { createToolRegistry } from "../tools";

describe("createToolRegistry", () => {
  it("omits consult when Tier 2 is disabled", () => {
    const tools = createToolRegistry(resolveConfig({ tier2Enabled: false }));
    expect(Object.keys(tools).sort()).toEqual(["get_catalog", "search_products", "validate_build"]);
  });

  it("includes consult when Tier 2 is enabled", () => {
    const tools = createToolRegistry(resolveConfig({ tier2Enabled: true }));
    expect(Object.keys(tools).sort()).toEqual(["consult", "get_catalog", "search_products", "validate_build"]);
  });
});
