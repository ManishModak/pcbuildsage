"use client";

import { useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icon";

export function Composer({
  onSend,
  onStop,
  streaming,
  disabled,
  placeholder
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue("");
    if (ref.current) ref.current.style.height = "auto";
  };

  return (
    <div className="rounded-card border border-border bg-surface p-2 focus-within:border-accent">
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
            disabled={disabled || value.trim().length === 0}
            aria-label="Send message"
            className={cn(
              "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-btn transition-colors duration-150",
              value.trim().length === 0 || disabled
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
