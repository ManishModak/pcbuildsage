import { Radio } from "lucide-react";
import { Icon } from "../ui/icon";
import type { ChatMetadata } from "../lib/types";

// Fallback is always visible: when a response came from a non-primary provider,
// a small pill discloses which provider/model actually served it.
export function FailoverPill({ meta }: { meta: ChatMetadata | undefined }) {
  if (!meta || meta.fallbackIndex <= 0) return null;
  return (
    <span
      className="mt-2 inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 font-mono text-caption"
      style={{
        color: "var(--warn)",
        borderColor: "color-mix(in srgb, var(--warn) 45%, transparent)",
        backgroundColor: "color-mix(in srgb, var(--warn) 10%, transparent)"
      }}
      title={`Served by fallback #${meta.fallbackIndex} in your chain`}
    >
      <Icon icon={Radio} size={13} />
      via {meta.provider} · {meta.model}
    </span>
  );
}
