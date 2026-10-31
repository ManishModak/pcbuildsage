"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icon";
import { isHostedMode } from "@/lib/api-client";
import { getActiveByokProvider, hasByokKey, listStoredProviders } from "@/lib/llm/client-byok-store";

/**
 * In hosted mode the chat needs a BYOK key. Returns true when sending must be
 * blocked: hosted mode and no provider the chat could use has a key.
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
  const stored = options?.storedProviders ?? listStoredProviders();
  // Same fallback as resolveChatRequestBody: any provider with a key can serve the chat.
  const candidates = [active, ...stored, ...HOSTED_FALLBACK_PROVIDERS].filter((p): p is string => Boolean(p));
  return !candidates.some((provider) => hasKeyFn(provider));
}

const HOSTED_FALLBACK_PROVIDERS = ["gemini", "groq", "openrouter"];

export function Composer({
  onSend,
  onStop,
  streaming,
  disabled,
  placeholder,
  badge,
  status,
  initialValue = ""
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
  placeholder?: string;
  badge?: React.ReactNode;
  /** Shown left of the send button: which model answers and whether it's busy. */
  status?: React.ReactNode;
  /** Prefilled draft (read once on mount); the user still has to send it. */
  initialValue?: string;
}) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Size a prefilled draft to its content, like typing would.
  useEffect(() => {
    const el = ref.current;
    if (!el || !el.value) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);
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

  const canSend = !disabled && !sendBlocked && value.trim().length > 0;

  return (
    <div className="composer rounded-dialog border border-border bg-surface p-1.5 shadow-[0_18px_40px_-24px_color-mix(in_srgb,var(--bg)_70%,black)] transition-colors duration-150">
      {badge ? <div className="mb-1 px-1.5 pt-1">{badge}</div> : null}
      {sendBlocked ? (
        <div
          className="mb-1.5 flex flex-wrap items-center justify-between gap-2 rounded-card border border-warn/40 bg-warn/10 px-3 py-2 text-caption text-text"
          data-testid="byok-missing-prompt"
          role="alert"
        >
          <span>Add your API key to continue.</span>
          <a href="/settings?tab=llm" className="font-medium text-accent hover:underline">
            Add a key in Settings
          </a>
        </div>
      ) : null}
      <textarea
        ref={ref}
        rows={1}
        value={value}
        disabled={disabled}
        placeholder={placeholder ?? "Describe the PC you want…"}
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
        className="block max-h-52 min-h-12 w-full resize-none bg-transparent px-2.5 pb-1 pt-2.5 text-base leading-relaxed text-text outline-none placeholder:text-text-muted"
        aria-label="Message the sage"
      />
      <div className="flex min-h-10 items-center justify-between gap-2">
        <div className="min-w-0">{status}</div>
        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop generating"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-btn border border-border text-text-secondary transition-colors duration-150 hover:bg-surface-raised hover:text-text"
          >
            <Icon icon={Square} size={15} />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            aria-label="Send message"
            className={cn(
              "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-btn transition-colors duration-150",
              canSend ? "bg-accent text-on-accent hover:opacity-90" : "bg-surface-raised text-text-muted"
            )}
          >
            <Icon icon={ArrowUp} size={18} />
          </button>
        )}
      </div>
    </div>
  );
}
