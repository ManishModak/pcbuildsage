import { describe, expect, it } from "vitest";
import { inlineAppBundle } from "../build-card";

describe("inlineAppBundle", () => {
  it("rewrites the trailing ESM export into a local binding", () => {
    expect(inlineAppBundle("var a=1,b=2;export{a as App,b};")).toBe("var a=1,b=2;\nconst __extApps={App:a,b:b};");
  });

  it("fails loudly if the bundle format changes", () => {
    expect(() => inlineAppBundle("var a=1;")).toThrow(/no trailing export/);
  });
});
