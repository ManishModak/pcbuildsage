import { tool } from "ai";
import { z } from "zod";

export const presentBuildInputSchema = z.object({
  builds: z
    .array(
      z.object({
        label: z.string().describe("Tradeoff or persona label, e.g. 'Max Performance', 'Value Gaming', 'Quiet & Compact'"),
        parts: z
          .array(
            z.object({
              category: z.enum(["gpu", "cpu", "motherboard", "ram", "storage", "psu", "case", "cooler"]).describe("Component category"),
              product_id: z.string().min(1).optional().describe("Exact search_products result id, also passed to validate_build for this part."),
              name: z.string().describe("Full product name / model"),
              price: z.number().nullable().optional().describe("Price in standard major currency units (e.g. standard INR or USD)"),
              currency: z.string().optional().describe("Currency code, e.g. 'INR'"),
              retailer: z.string().optional().describe("Retailer name, e.g. 'Kryptronix', 'MDComputers'"),
              url: z.string().optional().describe("Direct buy URL from search_products")
            })
          )
          .min(1)
          .describe("List of parts in the build"),
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
      "Present one or more complete, finalized PC builds to the user as an interactive visual card with toggle tabs, retailer buy links, and total price calculation. Call this when you want to present the final build(s). Do NOT repeat a markdown table of parts/prices in your text response when calling this tool.",
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
