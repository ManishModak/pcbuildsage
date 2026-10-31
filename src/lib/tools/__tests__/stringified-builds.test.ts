import { describe, expect, it } from "vitest";
import { presentBuildInputSchema } from "../present-build";
import { validateBuildInputSchema } from "../validate-build";

// Some models (seen with Nemotron) send nested array arguments as JSON strings.
describe("stringified builds arguments", () => {
  const build = { label: "Within budget", parts: { cpu: { product_id: "ceb1047b27" } } };

  it("validate_build accepts builds sent as a JSON string", () => {
    const parsed = validateBuildInputSchema.safeParse({ builds: JSON.stringify([build]), budget: 70000 });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.builds[0].label).toBe("Within budget");
  });

  it("present_build accepts builds sent as a JSON string", () => {
    const parsed = presentBuildInputSchema.safeParse({ builds: JSON.stringify([{ label: "Within budget" }]) });
    expect(parsed.success).toBe(true);
  });

  it("still rejects strings that are not valid build JSON", () => {
    expect(validateBuildInputSchema.safeParse({ builds: "[{label: oops" }).success).toBe(false);
    expect(validateBuildInputSchema.safeParse({ builds: JSON.stringify({ label: "x" }) }).success).toBe(false);
  });
});
