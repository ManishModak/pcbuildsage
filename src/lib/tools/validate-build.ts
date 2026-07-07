import { tool } from "ai";
import { z } from "zod";
import { validateBuild, type BuildParts } from "../rules-engine";

const componentCategorySchema = z.enum(["cpu", "gpu", "motherboard", "ram", "storage", "psu", "case", "cooler"]);

const partSchema = z.union([
  z.string().describe("Registry key or component name."),
  z.object({
    key: z.string().optional().describe("Canonical registry key when known."),
    name: z.string().optional().describe("Human-readable component name when key is not known."),
    category: componentCategorySchema.optional().describe("Component category hint.")
  }).refine((part) => Boolean(part.key?.trim() || part.name?.trim()), { message: "Part object must include at least one of key or name." })
]);

export const validateBuildInputSchema = z.object({
  parts: z
    .object({
      cpu: partSchema.optional().describe("Selected CPU."),
      gpu: partSchema.optional().describe("Selected GPU."),
      motherboard: partSchema.optional().describe("Selected motherboard."),
      ram: partSchema.optional().describe("Selected memory kit."),
      storage: z.union([partSchema, z.array(partSchema)]).optional().describe("Selected storage drive or drives."),
      psu: partSchema.optional().describe("Selected power supply."),
      case: partSchema.optional().describe("Selected case."),
      cooler: partSchema.optional().describe("Selected CPU cooler.")
    })
    .describe("Current build parts keyed by component category.")
});

export function createValidateBuildTool() {
  return tool({
    description:
      "Use validate_build before locking a component choice and on the final build. It is deterministic Tier 1 compatibility authority; do not use it for price search or advisory web research. Example: {\"parts\":{\"cpu\":\"amd-ryzen-7-9700x\",\"motherboard\":\"msi-b650-a\",\"ram\":\"corsair-vengeance-32gb-ddr5-6000\"}}.",
    inputSchema: validateBuildInputSchema,
    execute: async ({ parts }: { parts: BuildParts }) => validateBuild(parts)
  });
}
