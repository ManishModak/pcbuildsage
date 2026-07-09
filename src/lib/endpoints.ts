import path from "node:path";
import { z } from "zod";
import { loadJsonPresets } from "./json-presets";

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
  return loadJsonPresets(dir, endpointPresetSchema, {
    collectionLabel: "endpoint presets",
    invalidLabel: "endpoint preset"
  });
}
