"use client";

import { useEffect, useState } from "react";
import type { UIMessage } from "@ai-sdk/react";
import { formatClock } from "../lib/format";
import type { ChatMetadata } from "../lib/types";
import { BuildCard } from "./build-card";
import { deriveBuilds } from "./build-derive";
import { FailoverPill } from "./failover-pill";
import { Markdown } from "./markdown";
import { ToolChip, type ToolPart } from "./tool-chip";

export type ChatUIMessage = UIMessage<ChatMetadata>;

export function MessageView({
  message,
  personaLabels,
  currency
}: {
  message: ChatUIMessage;
  personaLabels: string[];
  currency: string;
}) {
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-only hydration check is safe
    setHasMounted(true);
  }, []);

  const rawDate = (message as { createdAt?: Date | string | number }).createdAt
    ? new Date((message as { createdAt?: Date | string | number }).createdAt!)
    : null;
  const timestamp = hasMounted && rawDate ? formatClock(rawDate.toISOString()) : "";
  const isUser = message.role === "user";
  const toolParts = message.parts.filter((part) => part.type.startsWith("tool-")) as ToolPart[];
  const builds = isUser ? [] : deriveBuilds(toolParts, currency);

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-card border border-border bg-surface px-4 py-2.5">
          {message.parts.map((part, index) =>
            part.type === "text" ? (
              <p key={index} className="whitespace-pre-wrap text-base leading-relaxed text-text">
                {part.text}
              </p>
            ) : null
          )}
          {timestamp ? <p className="mt-1 text-right text-caption text-text-muted">{timestamp}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {message.parts.map((part, index) => {
        if (part.type === "text") return <Markdown key={index} text={part.text} />;
        if (part.type.startsWith("tool-")) return <ToolChip key={index} part={part as ToolPart} />;
        return null;
      })}

      {builds.length ? <BuildCard builds={builds} personaLabels={personaLabels} /> : null}

      <FailoverPill meta={message.metadata} />
      {timestamp ? <p className="mt-1 text-caption text-text-muted">{timestamp}</p> : null}
    </div>
  );
}
