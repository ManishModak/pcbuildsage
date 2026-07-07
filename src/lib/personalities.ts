import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

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
  const personalities = readdirSync(resolvedDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({ id: file.replace(/\.json$/, ""), ...personalitySchema.parse(JSON.parse(readFileSync(path.join(resolvedDir, file), "utf8"))) }));
  cachedPersonalities.set(resolvedDir, personalities);
  return personalities;
}

export function getPersonality(id: string): Personality | undefined {
  return loadPersonalities().find((personality) => personality.id === id || personality.name === id);
}

export function resetPersonalityCache(): void {
  cachedPersonalities = new Map();
}
