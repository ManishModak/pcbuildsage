import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const endpointPresetSchema = z.object({
  $schema: z.string().optional(),
  name: z.string(),
  provider_class: z.literal("openai-compatible"),
  base_url: z.string().url(),
  default_port: z.number().int().optional(),
  requires_key: z.boolean(),
  model_list_style: z.enum(["openai", "ollama"]),
  tool_support_notes: z.string().optional(),
  launch_flags: z.string().optional()
});
export type EndpointPreset = z.infer<typeof endpointPresetSchema>;

export function loadEndpointPresets(dir = path.join(process.cwd(), "data", "endpoints")): EndpointPreset[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (error) {
    console.warn(`Skipping endpoint presets in ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  return files
    .filter((file) => file.endsWith(".json"))
    .sort()
    .flatMap((file) => {
      const filePath = path.join(dir, file);
      try {
        const parsed = endpointPresetSchema.safeParse(JSON.parse(readFileSync(filePath, "utf8")));
        if (parsed.success) return [parsed.data];
        console.warn(`Skipping invalid endpoint preset ${filePath}: ${parsed.error.message}`);
      } catch (error) {
        console.warn(`Skipping invalid endpoint preset ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return [];
    });
}
