import type { LucideIcon } from "lucide-react";
import { CircleCheck, FlaskConical, OctagonX, TriangleAlert } from "lucide-react";
import { cn } from "./cn";
import { Icon } from "./icon";

// The four trust states — the heart of the product. Always triple-encoded:
// color + icon + text label. Never color alone.
export type StatusKind = "ok" | "blocking" | "warn" | "unverified";

const STATUS: Record<StatusKind, { icon: LucideIcon; color: string; word: string }> = {
  ok: { icon: CircleCheck, color: "var(--ok)", word: "OK" },
  blocking: { icon: OctagonX, color: "var(--blocking)", word: "Blocking" },
  warn: { icon: TriangleAlert, color: "var(--warn)", word: "Warning" },
  unverified: { icon: FlaskConical, color: "var(--unverified)", word: "Unverified" }
};

export function StatusBadge({
  kind,
  label,
  className,
  title
}: {
  kind: StatusKind;
  /** Human label; falls back to the state's word so it is never color-only. */
  label?: string;
  className?: string;
  title?: string;
}) {
  const status = STATUS[kind];
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-caption font-medium",
        className
      )}
      style={{
        color: status.color,
        borderColor: `color-mix(in srgb, ${status.color} 45%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${status.color} 12%, transparent)`
      }}
    >
      <Icon icon={status.icon} size={14} />
      <span className="whitespace-nowrap font-mono">{label ?? status.word}</span>
    </span>
  );
}

export function statusIcon(kind: StatusKind): LucideIcon {
  return STATUS[kind].icon;
}

export function statusColor(kind: StatusKind): string {
  return STATUS[kind].color;
}
