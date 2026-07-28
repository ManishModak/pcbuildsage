import { useState } from "react";
import { Radio, TriangleAlert } from "lucide-react";
import { Icon } from "../ui/icon";
import type { ChatMetadata } from "../lib/types";
import { getErrorMessageText } from "../lib/format";


// Fallback is always visible: when a response came from a non-primary provider,
// a clean transition banner discloses the primary error details and routing info.
// Click to expand shows the full untruncated error description.
export function FailoverPill({ meta }: { meta: ChatMetadata | undefined }) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!meta || meta.fallbackIndex <= 0) return null;

  const cleanError = meta.primaryError ? getErrorMessageText(meta.primaryError) : "Failed to connect";

  return (
    <div
      onClick={() => setIsExpanded(!isExpanded)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setIsExpanded(!isExpanded);
        }
      }}
      role="button"
      tabIndex={0}
      className="mb-3 flex flex-col gap-2 rounded-card border px-3 py-2 text-caption select-none cursor-pointer hover:bg-surface-raised/15 transition-colors shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-accent"
      style={{
        color: "var(--warn)",
        borderColor: "color-mix(in srgb, var(--warn) 30%, transparent)",
        backgroundColor: "color-mix(in srgb, var(--warn) 5%, transparent)"
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Icon icon={TriangleAlert} size={14} className="shrink-0" />
          <span className={`font-medium ${isExpanded ? "" : "truncate"}`}>
            Primary model error: {isExpanded ? "" : cleanError}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 text-text-secondary border-l pl-3 font-mono text-[10px]" style={{ borderColor: "color-mix(in srgb, var(--warn) 20%, transparent)" }}>
          <Icon icon={Radio} size={11} className="animate-pulse text-accent" />
          <span>Fallback #{meta.fallbackIndex} ({meta.provider})</span>
        </div>
      </div>

      {isExpanded ? (
        <div
          className="mt-1 pl-5 text-text-secondary font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap select-text border-t pt-2 border-dashed"
          style={{ borderColor: "color-mix(in srgb, var(--warn) 20%, transparent)" }}
          onClick={(e) => e.stopPropagation()} // Prevent closing when highlighting/clicking text
        >
          {cleanError}
        </div>
      ) : null}
    </div>
  );
}
