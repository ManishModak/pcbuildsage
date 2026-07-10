import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class values with Tailwind-aware conflict resolution so consumer
 * overrides (e.g. `px-6`) beat component defaults (e.g. `px-4`).
 */
export function cn(...values: ClassValue[]): string {
  return twMerge(clsx(values));
}
