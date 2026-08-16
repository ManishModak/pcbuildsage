import { describe, expect, it } from "vitest";
import { createPresentBuildTool, presentBuildInputSchema } from "../tools/present-build";

describe("present_build tool", () => {
  it("validates structured input with builds and parts", () => {
    const valid = presentBuildInputSchema.safeParse({
      builds: [
        {
          label: "Max Performance",
          parts: [
            { category: "gpu", name: "RTX 5060", price: 35900, retailer: "Kryptronix", url: "https://kryptronix.in/rtx5060" },
            { category: "cpu", name: "Ryzen 5 5600X", price: 13950 }
          ]
        }
      ]
    });
    expect(valid.success).toBe(true);
  });

  it("executes and returns presented confirmation and build count", async () => {
    const tool = createPresentBuildTool();
    const input = {
      builds: [
        {
          label: "Max Performance",
          parts: [{ category: "gpu" as const, name: "RTX 5060", price: 35900 }]
        },
        {
          label: "Value Gaming",
          parts: [{ category: "gpu" as const, name: "RTX 5050", price: 24900 }]
        }
      ]
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await tool.execute!(input, { toolCallId: "test-call", messages: [] } as any);
    expect(result).toEqual({
      presented: true,
      buildCount: 2,
      builds: input.builds
    });
  });
});
