import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const personaSchema = z.object({
  $schema: z.string(),
  persona_name: z.string(),
  description: z.string(),
  budget_weights: z.record(z.string(), z.number()),
  priorities: z.array(z.string()),
  tone: z.string()
});
export type Persona = z.infer<typeof personaSchema> & { id: string };

let cachedPersonas = new Map<string, Persona[]>();

export function loadPersonas(dir = path.join(process.cwd(), "data", "personas")): Persona[] {
  const resolvedDir = path.resolve(dir);
  const cached = cachedPersonas.get(resolvedDir);
  if (cached) return cached;
  const personas = readdirSync(resolvedDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({ id: file.replace(/\.json$/, ""), ...personaSchema.parse(JSON.parse(readFileSync(path.join(resolvedDir, file), "utf8"))) }));
  cachedPersonas.set(resolvedDir, personas);
  return personas;
}

export function getPersona(id: string): Persona | undefined {
  return loadPersonas().find((persona) => persona.id === id || persona.persona_name === id);
}

export function resetPersonaCache(): void {
  cachedPersonas = new Map();
}
