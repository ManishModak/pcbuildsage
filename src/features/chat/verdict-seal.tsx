import { statusIcon, type StatusKind } from "@/components/ui/status-badge";
import { Icon } from "@/components/ui/icon";
import type { StripBadge } from "./validation-strip";

// What the seal says for each overall verdict. The badges under it give the detail.
const WORDS: Record<StatusKind, string> = {
  ok: "Checked",
  blocking: "Won't fit",
  warn: "Notes",
  unverified: "Partly checked"
};

const RING = "ᚠᚢᚦᚨᚱᚲᚷᚹ ᚺᚾᛁᛃᛇᛈ ᛉᛊᛏᛒᛖᛗ ᛚᛜᛞᛟ ";

/**
 * The build's compatibility verdict as a stamped seal beside the total: the
 * rules engine's word on the build, ringed with runes. It stamps down once
 * when it mounts (.seal-stamp). The first strip badge is the summary, so its
 * kind is the verdict and its title is the seal's accessible name.
 */
export function VerdictSeal({ strip, id }: { strip: StripBadge[]; id: string }) {
  const summary = strip[0];
  if (!summary) return null;
  const color = `var(--${summary.kind})`;
  const ringId = `${id}-ring`;
  return (
    <div
      role="img"
      aria-label={`Compatibility: ${WORDS[summary.kind]}. ${summary.title}`}
      title={summary.title}
      className="seal-stamp relative grid h-[88px] w-[88px] shrink-0 place-items-center"
      style={{ color }}
    >
      <svg viewBox="0 0 88 88" className="absolute inset-0 h-full w-full" aria-hidden="true">
        <defs>
          <path id={ringId} d="M44,44 m-33,0 a33,33 0 1,1 66,0 a33,33 0 1,1 -66,0" />
        </defs>
        <circle cx="44" cy="44" r="42" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="44" cy="44" r="26" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 3" />
        <text
          fill="currentColor"
          fontSize="9.5"
          letterSpacing="1.2"
          style={{ fontFamily: "var(--font-runic)" }}
        >
          <textPath href={`#${ringId}`}>{RING}</textPath>
        </text>
      </svg>
      <span className="relative flex flex-col items-center gap-0.5 text-center">
        <Icon icon={statusIcon(summary.kind)} size={16} />
        <span className="type-label max-w-[48px] text-[11px] leading-[1.1]">{WORDS[summary.kind]}</span>
      </span>
    </div>
  );
}
