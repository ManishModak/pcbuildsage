import { describe, expect, it } from "vitest";
import { validateBuildInputSchema } from "../tools/validate-build";

describe("validate_build input schema", () => {
  it("rejects empty part objects", () => {
    expect(validateBuildInputSchema.safeParse({ parts: { cpu: {} } }).success).toBe(false);
    expect(validateBuildInputSchema.safeParse({ parts: { cpu: { key: "amd-ryzen-7-9700x" } } }).success).toBe(true);
  });
});
