import { describe, expect, it } from "vitest";
import { z } from "zod";
import { lenientToolSchema } from "../../tools/lenient-input";
import { resolveAiSchema, toStandardSchema } from "../standard-schema";

const lenient = lenientToolSchema(z.object({ price_max: z.number().optional() }), "demo");

describe("toStandardSchema", () => {
  it("advertises the AI SDK JSON Schema unchanged", async () => {
    const resolved = await resolveAiSchema(lenient);
    const std = toStandardSchema(resolved)["~standard"];
    expect(std.jsonSchema.input({ target: "draft-2020-12" })).toEqual(await lenient.jsonSchema);
  });

  it("keeps lenient coercion and unknown-field passthrough", async () => {
    const std = toStandardSchema(await resolveAiSchema(lenient))["~standard"];
    expect(await std.validate({ price_max: "50000", colour: "red" })).toEqual({ value: { price_max: 50000, colour: "red" } });
  });

  it("reports failures as Standard Schema issues", async () => {
    const std = toStandardSchema(await resolveAiSchema(lenient))["~standard"];
    const result = await std.validate({ price_max: "abc" });
    expect(result.issues?.[0].message).toContain("price_max");
  });
});
