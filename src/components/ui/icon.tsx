import type { LucideIcon } from "lucide-react";
import { cn } from "./cn";

// Lucide everywhere, one stroke width (1.5px). No emoji as UI icons.
export function Icon({
  icon: LucideGlyph,
  size = 16,
  className,
  label
}: {
  icon: LucideIcon;
  size?: number;
  className?: string;
  /** Provide when the icon is the only label; otherwise it is decorative. */
  label?: string;
}) {
  return (
    <LucideGlyph
      size={size}
      strokeWidth={1.5}
      className={cn("shrink-0", className)}
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      suppressHydrationWarning
    />
  );
}
