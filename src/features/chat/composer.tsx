"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icon";
import { isHostedMode } from "@/lib/api-client";
import { getActiveByokProvider, hasByokKey, listStoredProviders } from "@/lib/llm/client-byok-store";

/**
 * In hosted mode the chat needs a BYOK key. Returns true when sending must be
 * blocked: hosted with an active provider that has no key, or hosted with no
 * keys stored at all.
 */
export function hostedSendBlocked(options?: {
  isHosted?: boolean;
  activeProvider?: string | null;
  hasKey?: (provider: string) => boolean;
  storedProviders?: string[];
}): boolean {
  const isHosted = options?.isHosted ?? isHostedMode();
  if (!isHosted) return false;
  const hasKeyFn = options?.hasKey ?? hasByokKey;
  const active = options?.activeProvider !== undefined ? options.activeProvider : getActiveByokProvider();
  if (active) return !hasKeyFn(active);
  const stored = options?.storedProviders ?? listStoredProviders();
  return !stored.some((provider) => hasKeyFn(provider));
}

export function Composer({
  onSend,
  onStop,
  streaming,
  disabled,
  placeholder,
  badge
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
  placeholder?: string;
  badge?: React.ReactNode;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  // Re-evaluate the hosted BYOK gate when storage changes (key added/removed
  // in another tab) or when the window regains focus.
  const [byokTick, setByokTick] = useState(0);
  useEffect(() => {
    const refresh = () => setByokTick((tick) => tick + 1);
    window.addEventListener("storage", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  void byokTick;
  const sendBlocked = hostedSendBlocked();

  const submit = () => {
    const text = value.trim();
    if (!text || disabled || sendBlocked) return;
    onSend(text);
    setValue("");
    if (ref.current) ref.current.style.height = "auto";
  };

  return (
    <div className="rounded-card border border-border bg-surface p-2 focus-within:border-accent">
      {badge ? <div className="mb-1 px-1">{badge}</div> : null}
      {sendBlocked ? (
        <div
          className="mb-2 flex items-center justify-between gap-2 rounded-btn border border-warn/40 bg-warn/10 px-3 py-2 text-caption text-text"
          data-testid="byok-missing-prompt"
          role="alert"
        >
          <span>Add your API key to continue.</span>
          <a href="/settings?tab=llm" className="font-medium text-accent hover:underline">
            BYOK settings
          </a>
        </div>
      ) : null}
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={placeholder ?? "Describe your build goal, budget, or paste a part list…"}
          onChange={(event) => {
            setValue(event.target.value);
            const el = event.target;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          className="max-h-52 min-h-11 flex-1 resize-none bg-transparent px-2 py-2.5 text-base leading-relaxed text-text outline-none placeholder:text-text-muted"
          aria-label="Message the sage"
        />
        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop generating"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-btn border border-border text-text-secondary transition-colors duration-150 hover:bg-surface-raised hover:text-text"
          >
            <Icon icon={Square} size={16} />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={disabled || sendBlocked || value.trim().length === 0}
            aria-label="Send message"
            className={cn(
              "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-btn transition-colors duration-150",
              value.trim().length === 0 || disabled || sendBlocked
                ? "bg-surface-raised text-text-muted"
                : "bg-accent text-on-accent hover:opacity-90"
            )}
          >
            <Icon icon={ArrowUp} size={18} />
          </button>
        )}
      </div>
    </div>
  );
}
