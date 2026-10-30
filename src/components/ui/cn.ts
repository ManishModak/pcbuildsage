import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// `text-caption` is a custom font size (globals.css @theme). Without this,
// tailwind-merge reads it as a colour and drops it when a colour class follows.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["caption"] } } });

/**
 * Merge class values with Tailwind-aware conflict resolution so consumer
 * overrides (e.g. `px-6`) beat component defaults (e.g. `px-4`).
 */
export function cn(...values: ClassValue[]): string {
  return twMerge(clsx(values));
}
