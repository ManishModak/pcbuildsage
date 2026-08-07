import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";

export function loadJsonPresets<T extends object>(
  dir: string,
  schema: z.ZodType<T>,
  options: {
    collectionLabel: string;
    invalidLabel: string;
    includeId?: boolean;
  }
): Array<T & { id: string }> {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (error) {
    console.warn(`Skipping ${options.collectionLabel} in ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  return files
    .filter((file) => file.endsWith(".json"))
    .sort()
    .flatMap((file) => {
      const filePath = path.join(dir, file);
      try {
        const parsed = schema.safeParse(JSON.parse(readFileSync(filePath, "utf8")));
        if (parsed.success) {
          return [{ ...(options.includeId ? { id: file.replace(/\.json$/, "") } : {}), ...parsed.data } as T & { id: string }];
        }
        console.warn(`Skipping invalid ${options.invalidLabel} ${filePath}: ${parsed.error.message}`);
      } catch (error) {
        console.warn(`Skipping invalid ${options.invalidLabel} ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return [];
    });
}
