import { tool } from "ai";
import { z } from "zod";

export const presentBuildInputSchema = z.object({
  builds: z
    .array(
      z.object({
        label: z
          .string()
          .min(1)
          .describe(
            "Tradeoff or persona label matching a validate_build label, e.g. 'Within budget', 'Small upgrade', 'Max Performance'"
          ),
        product_ids: z
          .array(z.string())
          .min(1)
          .describe(
            "List of exact catalog product IDs included in this build from search_products or the validation snapshot."
          ),
        notes: z.string().optional().describe("Optional brief description of this build variant")
      })
    )
    .min(1)
    .describe("One or more complete build proposals")
});

export type PresentBuildInput = z.infer<typeof presentBuildInputSchema>;

export function createPresentBuildTool() {
  return tool({
    description:
      "Present one or more complete, finalized PC builds to the user as an interactive visual card with toggle tabs, retailer buy links, and total price calculation. Call this when you want to present the final build(s). Pass references (product_ids) and labels matching validate_build; do not retype product names, prices, or links. All pricing, retailer links, and totals come authoritatively from the matching validate_build snapshot. Do NOT repeat a markdown table of parts/prices in your text response.",
    inputSchema: presentBuildInputSchema,
    execute: async (input) => {
      return {
        presented: true,
        buildCount: input.builds.length,
        builds: input.builds
      };
    }
  });
}
