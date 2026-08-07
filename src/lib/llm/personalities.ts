import path from "node:path";
import { z } from "zod";
import { loadJsonPresets } from "./presets";

export const personalitySchema = z.object({
  $schema: z.string().optional(),
  name: z.string(),
  description: z.string(),
  prompt: z.string()
});
export type Personality = z.infer<typeof personalitySchema> & { id: string };

let cachedPersonalities = new Map<string, Personality[]>();

export function loadPersonalities(dir = path.join(process.cwd(), "data", "personalities")): Personality[] {
  const resolvedDir = path.resolve(dir);
  const cached = cachedPersonalities.get(resolvedDir);
  if (cached) return cached;
  const personalities = loadJsonPresets(resolvedDir, personalitySchema, {
    collectionLabel: "personalities",
    invalidLabel: "personality",
    includeId: true
  });
  cachedPersonalities.set(resolvedDir, personalities);
  return personalities;
}

export function getPersonality(id: string): Personality | undefined {
  return loadPersonalities().find((personality) => personality.id === id || personality.name === id);
}

export function resetPersonalityCache(): void {
  cachedPersonalities = new Map();
}
