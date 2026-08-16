"use client";

import { useEffect, useId, useState } from "react";
import type { UIMessage } from "@ai-sdk/react";
import { ArrowRight, Brain, ChevronDown, Package, Pencil, RefreshCw } from "lucide-react";
import { formatClock, formatPrice, sumPrices } from "@/lib/format";
import type { ChatMetadata } from "@/types/client";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/components/ui/cn";
import { Button } from "@/components/ui/button";
import { deriveBuilds, type DerivedBuild } from "./build-derive";
import { FailoverPill } from "./failover-pill";
import { Markdown } from "./markdown";
import { ToolChip } from "./tool-chip";
import { isTextPart, isReasoningPart, isToolPart } from "@/lib/message-parts";

export type ChatUIMessage = UIMessage<ChatMetadata> & {
  createdAt?: Date;
};

function ThinkingTrace({ text }: { text: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const contentId = useId();

  if (!text) return null;

  return (
    <div className="mb-3 overflow-hidden border rounded-card border-border bg-surface-muted/30">
      <button
        type="button"
        aria-expanded={isExpanded}
        aria-controls={contentId}
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm text-text-muted hover:bg-surface-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Icon icon={Brain} className="animate-pulse text-primary/70" />
          <span className="font-medium text-text-muted">Sage thinking process...</span>
        </div>
        <Icon
          icon={ChevronDown}
          className={cn("text-text-muted transition-transform duration-200", {
            "rotate-180": isExpanded
          })}
        />
      </button>
      {isExpanded && (
        <div id={contentId} className="border-t border-border/50 bg-surface-muted/10 px-4 py-3 font-mono text-sm leading-relaxed text-text-muted/80 whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}

export function MessageView({
  message,
  currency,
  onEdit,
  onViewBuild
}: {
  message: ChatUIMessage;
  currency: string;
  onEdit?: (newText: string) => void;
  onViewBuild?: (builds: DerivedBuild[]) => void;
}) {
  const [hasMounted, setHasMounted] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState("");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-only hydration check is safe
    setHasMounted(true);
  }, []);

  const rawDate = message.createdAt ?? null;
  const timestamp = hasMounted && rawDate ? formatClock(rawDate.toISOString()) : "";
  const isUser = message.role === "user";
  const toolParts = message.parts.filter(isToolPart);
  const builds = isUser ? [] : deriveBuilds(toolParts, currency);

  const textContent = message.parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join("\n");

  const startEditing = () => {
    setEditText(textContent);
    setIsEditing(true);
  };

  const handleSave = () => {
    if (editText.trim() && onEdit) {
      onEdit(editText.trim());
      setIsEditing(false);
    }
  };

  if (isUser) {
    if (isEditing) {
      return (
        <div className="flex justify-end w-full">
          <div className="w-full max-w-[85%] rounded-card border border-border bg-surface p-3 flex flex-col gap-3 shadow-lg focus-within:border-accent transition-colors duration-150">
            <textarea
              aria-label="Edit message"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              className="min-h-[80px] w-full resize-none bg-transparent text-base leading-relaxed text-text outline-none placeholder:text-text-muted"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSave();
                } else if (e.key === "Escape") {
                  setIsEditing(false);
                }
              }}
            />
            <div className="flex justify-end gap-2 border-t border-border/30 pt-2">
              <Button
                variant="outline"
                size="xs"
                onClick={() => setIsEditing(false)}
              >
                Cancel
              </Button>
              <Button
                variant="default"
                size="xs"
                onClick={handleSave}
                disabled={!editText.trim()}
              >
                Save & Submit
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-end gap-1.5 group w-full">
        <div className="max-w-[85%] rounded-card border border-border bg-surface px-4 py-2.5">
          {message.parts.filter(isTextPart).map((part, index) => (
            <p key={index} className="whitespace-pre-wrap text-base leading-relaxed text-text">
              {part.text}
            </p>
          ))}
          {timestamp ? <p className="mt-1 text-right text-caption text-text-muted">{timestamp}</p> : null}
        </div>
        {onEdit && (
          <div className="flex items-center gap-3 px-1 opacity-100 transition-opacity duration-150 select-none md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100">
            <button
              type="button"
              onClick={startEditing}
              className="inline-flex min-h-11 items-center gap-1 rounded-btn px-2 text-caption font-medium text-text-muted hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent transition-colors cursor-pointer"
              title="Edit message"
            >
              <Icon icon={Pencil} size={12} />
              <span>Edit</span>
            </button>
            <button
              type="button"
              onClick={() => onEdit(textContent)}
              className="inline-flex min-h-11 items-center gap-1 rounded-btn px-2 text-caption font-medium text-text-muted hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent transition-colors cursor-pointer"
              title="Resend from this message"
            >
              <Icon icon={RefreshCw} size={12} />
              <span>Resend</span>
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <FailoverPill meta={message.metadata} />
      {message.parts.map((part, index) => {
        if (isReasoningPart(part)) {
          if (part.text) {
            return <ThinkingTrace key={index} text={part.text} />;
          }
        }
        if (isTextPart(part)) {
          return <Markdown key={index} text={part.text} />;
        }
        if (isToolPart(part)) {
          return <ToolChip key={index} part={part} />;
        }
        return null;
      })}

      {builds.length ? (
        <div className="my-3">
          <button
            type="button"
            onClick={() => onViewBuild?.(builds)}
            className="group flex w-full items-center justify-between gap-3 rounded-card border border-border bg-surface px-4 py-3 text-left shadow-xs transition-all duration-150 hover:border-accent hover:bg-surface-raised cursor-pointer"
            aria-label={`View proposed build: ${builds[0].label ?? "Proposed Build"}`}
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-btn bg-accent/10 text-accent group-hover:bg-accent group-hover:text-on-accent transition-colors duration-150">
                <Icon icon={Package} size={18} />
              </div>
              <div className="flex flex-col min-w-0">
                <div className="flex items-baseline gap-2 truncate">
                  <span className="text-caption font-semibold uppercase tracking-wider text-text-secondary">
                    Proposed Build
                  </span>
                  {builds.length > 1 ? (
                    <span className="rounded-pill bg-surface-raised px-2 py-0.5 text-[11px] font-medium text-text-muted">
                      {builds.length} variants
                    </span>
                  ) : null}
                </div>
                <span className="truncate text-sm font-medium text-text">
                  {builds[0].label ? `${builds[0].label} · ` : ""}
                  <span className="font-mono font-semibold text-accent">
                    {formatPrice(
                      sumPrices(builds[0].components.map((c) => c.price)),
                      builds[0].currency
                    )}
                  </span>
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0 text-caption font-medium text-text-secondary group-hover:text-accent transition-colors">
              <span className="hidden sm:inline">View Details</span>
              <Icon
                icon={ArrowRight}
                size={16}
                className="transition-transform duration-150 group-hover:translate-x-1"
              />
            </div>
          </button>
        </div>
      ) : null}

      <div className="mt-1 flex items-center gap-2 text-caption text-text-muted">
        {timestamp ? <span>{timestamp}</span> : null}
      </div>
    </div>
  );
}
