import { describe, expect, it } from "vitest";
import { createPresentBuildTool, presentBuildInputSchema } from "../present-build";
import { createSearchProductsTool } from "../search-products";
import { createValidateBuildTool, normalizeParts, VALIDATE_BUILD_INPUT_HINT, validateBuildInputSchema } from "../validate-build";
import { leadingJsonValue } from "../lenient-input";

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

  it("ignores junk after the array, such as a stray closing brace", () => {
    // Nemotron Lightning's exact shape: the array, then one extra "}".
    const parsed = validateBuildInputSchema.safeParse({ builds: `${JSON.stringify([build])}}`, budget: 35000 });
    expect(parsed.success).toBe(true);
    expect(leadingJsonValue(' [{"a":"x]}"}] trailing')).toEqual([{ a: "x]}" }]);
    expect(leadingJsonValue('{"a":"\\"}"}}')).toEqual({ a: '"}' });
    expect(leadingJsonValue("oops [1]")).toBeUndefined();
  });

  it("repairs an object's closing brace written after the array's ]", () => {
    // Lightning r9: "[{...}}]}" where "[{...}}}]" was meant.
    const misplaced = `${JSON.stringify([build]).slice(0, -2)}]}`;
    const parsed = validateBuildInputSchema.safeParse({ builds: misplaced, budget: 35000 });
    expect(parsed.success && parsed.data.builds).toEqual([build]);
    expect(leadingJsonValue('{"a":1]}')).toEqual({ a: 1 });
  });
});

describe("tool JSON schemas sent to providers", () => {
  // parsedJson makes zod emit `builds` as optional; NIM's Nemotron then left it out of 7 in 8 calls.
  it("mark builds required for validate_build and present_build", () => {
    for (const tool of [createValidateBuildTool(), createPresentBuildTool()]) {
      expect((tool.inputSchema as unknown as { jsonSchema: { required?: string[] } }).jsonSchema.required).toEqual(["builds"]);
    }
  });

  it("leave all-optional search filters without a required list entry", () => {
    const search = createSearchProductsTool({ countryCode: "IN", currency: "INR" });
    expect((search.inputSchema as unknown as { jsonSchema: { required?: string[] } }).jsonSchema.required ?? []).toEqual([]);
  });
});

describe("rejected validate_build calls", () => {
  const validate = async (input: unknown) => {
    const tool = createValidateBuildTool();
    return (tool.inputSchema as unknown as { validate: (v: unknown) => Promise<{ success: boolean; error?: Error }> }).validate(input);
  };

  it("name the missing field once and show a working example", async () => {
    const result = await validate({ budget: 35000 });
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe(
      `Invalid validate_build input: builds: Invalid input: expected array, received undefined. ${VALIDATE_BUILD_INPUT_HINT}`
    );
  });

  it("treat empty part entries as absent parts instead of failing the call", async () => {
    const parts = { cpu: { product_id: "ceb1047b27" }, cooler: {}, gpu: null, case: "" };
    const result = (await validate({ builds: [{ label: "A", parts }] })) as { success: boolean; value?: { builds: Array<{ parts: object }> } };
    expect(result.success).toBe(true);
    expect(result.value?.builds[0].parts).toEqual({ cpu: { product_id: "ceb1047b27" } });
    expect(normalizeParts({ builds: JSON.stringify([{ label: "A", parts }]) })).toEqual({ builds: [{ label: "A", parts: { cpu: { product_id: "ceb1047b27" } } }] });
  });

  it("map part key aliases to their category, and reject a part key that names none", async () => {
    const cpu = { product_id: "9df61d0c3d" };
    const board = { product_id: "3a1ade8a84" };
    expect(normalizeParts({ builds: [{ label: "A", parts: { gpu: cpu, Processor: cpu, "Power Supply": board } }] })).toEqual({
      builds: [{ label: "A", parts: { gpu: cpu, cpu, psu: board } }]
    });
    // A taken category keeps the alias as written, whichever comes first, so it is rejected.
    expect(normalizeParts({ builds: [{ label: "A", parts: { processor: board, cpu } }] })).toEqual({ builds: [{ label: "A", parts: { cpu, processor: board } }] });
    const unknown = await validate({ builds: [{ label: "A", parts: { cpu, motherboard_chip: board } }] });
    expect(unknown.success).toBe(false);
    expect(unknown.error?.message).toContain("motherboard_chip");
    expect((await validate({ builds: [{ label: "A", parts: { cpu, mainboard: board } }] })).success).toBe(true);
  });

  it("drop a GPU entry standing for integrated graphics, keeping real cards", () => {
    const placeholder = { name: "Integrated Radeon Graphics (no discrete GPU)", owned: true };
    expect(normalizeParts({ builds: [{ label: "A", parts: { cpu: { product_id: "9df61d0c3d" }, gpu: placeholder } }] })).toEqual({
      builds: [{ label: "A", parts: { cpu: { product_id: "9df61d0c3d" } } }]
    });
    const card = { name: "RTX 3070", owned: true };
    expect(normalizeParts({ builds: [{ label: "A", parts: { gpu: card } }] })).toEqual({ builds: [{ label: "A", parts: { gpu: card } }] });
  });

  it("drop a boxed-cooler entry passed by name unless the user owns it", () => {
    const boxed = { name: "Wraith Stealth (included with Ryzen 5 5600G)", owned: false };
    expect(normalizeParts({ builds: [{ label: "A", parts: { cooler: boxed } }] })).toEqual({ builds: [{ label: "A", parts: {} }] });
    const owned = { name: "AMD Wraith Prism", owned: true };
    expect(normalizeParts({ builds: [{ label: "A", parts: { cooler: owned } }] })).toEqual({ builds: [{ label: "A", parts: { cooler: owned } }] });
  });

  it("report an unparseable string once, without zod's length issue", async () => {
    const result = await validate({ builds: "[{label: oops" });
    expect(result.error?.message).toContain('builds: Invalid input: expected array, received string (got "[{label: oops")');
    expect(result.error?.message).not.toContain("too_big");
    expect(result.error?.message).not.toContain("characters");
  });
});
