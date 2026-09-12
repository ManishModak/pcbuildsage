"use client";

import { useState } from "react";
import { Check, ChevronDown, Code, Copy, Download, FileText } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icon";
import type { ChatUIMessage } from "./message";
import {
  copyToClipboard,
  downloadTranscriptFile,
  formatJsonTranscript,
  formatMarkdownTranscript,
  type TranscriptOptions
} from "./transcript";

export interface TranscriptMenuProps {
  id?: string;
  title?: string | null;
  messages: ChatUIMessage[];
  modelName?: string;
  error?: unknown;
  currency?: string;
  countryCode?: string;
  className?: string;
}

export function TranscriptMenu({
  id,
  title,
  messages,
  modelName,
  error,
  currency,
  countryCode,
  className
}: TranscriptMenuProps) {
  const [copiedFormat, setCopiedFormat] = useState<"markdown" | "json" | null>(null);

  if (!messages || messages.length === 0) {
    return null;
  }

  const options: TranscriptOptions = {
    id,
    title,
    messages,
    modelName,
    error,
    currency,
    countryCode
  };

  const markCopied = (fmt: "markdown" | "json") => {
    setCopiedFormat(fmt);
    setTimeout(() => setCopiedFormat(null), 2000);
  };

  const handleCopyMarkdown = async () => {
    const md = formatMarkdownTranscript(options);
    const success = await copyToClipboard(md);
    if (success) markCopied("markdown");
  };

  const handleCopyJson = async () => {
    const jsonStr = formatJsonTranscript(options);
    const success = await copyToClipboard(jsonStr);
    if (success) markCopied("json");
  };

  const handleDownloadMarkdown = () => {
    const md = formatMarkdownTranscript(options);
    const safeTitle = (title || "chat")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const filename = `pcbuildsage-${safeTitle || "transcript"}-${new Date().toISOString().slice(0, 10)}.md`;
    downloadTranscriptFile(filename, md, "text/markdown;charset=utf-8");
  };

  return (
    <div
      className={cn(
        "inline-flex items-center rounded-btn border border-border bg-surface text-caption select-none shrink-0 transition-colors duration-150 hover:border-text-secondary/40",
        className
      )}
    >
      {/* Primary Click: Copy Markdown */}
      <button
        type="button"
        onClick={handleCopyMarkdown}
        aria-label={copiedFormat === "markdown" ? "Transcript copied" : "Copy chat transcript"}
        title="Copy chat transcript (Markdown)"
        className="inline-flex items-center gap-1.5 px-2.5 py-1 font-medium text-text hover:text-accent transition-colors duration-150 cursor-pointer"
      >
        <Icon
          icon={copiedFormat === "markdown" ? Check : Copy}
          size={13}
          className={copiedFormat === "markdown" ? "text-accent" : "text-text-muted"}
        />
        <span>{copiedFormat === "markdown" ? "Copied!" : "Transcript"}</span>
      </button>

      {/* Divider */}
      <div className="h-3.5 w-px bg-border my-auto shrink-0" />

      {/* Options Dropdown */}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="Transcript export formats"
            title="More export options"
            className="inline-flex items-center px-1.5 py-1 text-text-muted hover:text-text hover:bg-surface-raised transition-colors duration-150 cursor-pointer rounded-r-btn"
          >
            <Icon icon={ChevronDown} size={12} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="bottom"
            align="end"
            sideOffset={6}
            className="pcbs-fade-in z-50 min-w-48 rounded-card border border-border bg-surface-raised p-1 shadow-xl text-text"
            style={{ boxShadow: "0 16px 36px -12px rgba(0,0,0,0.5)" }}
          >
            <DropdownMenu.Item
              onClick={handleCopyMarkdown}
              className="flex cursor-pointer items-center gap-2 rounded-btn px-2.5 py-1.5 text-xs text-text-secondary outline-none transition-colors duration-150 hover:bg-surface hover:text-text"
            >
              <Icon
                icon={copiedFormat === "markdown" ? Check : FileText}
                size={14}
                className={copiedFormat === "markdown" ? "text-accent" : "text-text-muted"}
              />
              <span className="flex-1">Copy as Markdown</span>
            </DropdownMenu.Item>

            <DropdownMenu.Item
              onClick={handleCopyJson}
              className="flex cursor-pointer items-center gap-2 rounded-btn px-2.5 py-1.5 text-xs text-text-secondary outline-none transition-colors duration-150 hover:bg-surface hover:text-text"
            >
              <Icon
                icon={copiedFormat === "json" ? Check : Code}
                size={14}
                className={copiedFormat === "json" ? "text-accent" : "text-text-muted"}
              />
              <span className="flex-1">Copy as JSON (Debug)</span>
            </DropdownMenu.Item>

            <DropdownMenu.Separator className="my-1 h-px bg-border" />

            <DropdownMenu.Item
              onClick={handleDownloadMarkdown}
              className="flex cursor-pointer items-center gap-2 rounded-btn px-2.5 py-1.5 text-xs text-text-secondary outline-none transition-colors duration-150 hover:bg-surface hover:text-text"
            >
              <Icon icon={Download} size={14} className="text-text-muted" />
              <span className="flex-1">Download (.md)</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
