"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Maximize2, Minimize2, Package, TriangleAlert, X } from "lucide-react";
import { fetchStatus } from "@/lib/api-client";
import { apiKeyHeaders, toServerChain } from "@/lib/client-config-store";
import type { ClientConfig, StatusResponse } from "@/types/client";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/components/ui/cn";
import { Composer } from "./composer";
import { ChatEmptyState } from "./empty-state";
import { MessageView, type ChatUIMessage } from "./message";
import { BuildCard } from "./build-card";
import { extractBuildsFromMessage, type DerivedBuild } from "./build-derive";
import { useApp } from "@/components/app/app-provider";
import { getErrorMessage, formatRelativeTime, formatPrice, sumPrices, formatModelName } from "@/lib/format";
import { useIsDesktop } from "@/hooks/use-mobile";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription
} from "@/components/animate-ui/components/radix/sheet";
import { sessionSignature, type SessionSaveQueue } from "./session-save-queue";

function deriveTitle(messages: ChatUIMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  if (!firstUser) return "New chat";

  const rawContent = (firstUser as unknown as { content?: unknown }).content;
  const parts = Array.isArray(firstUser.parts)
    ? firstUser.parts
    : typeof rawContent === "string"
      ? [{ type: "text" as const, text: rawContent }]
      : [];

  const textPart = parts.find(
    (part): part is { type: "text"; text: string } =>
      part.type === "text" && typeof (part as { text?: unknown }).text === "string"
  );
  const text =
    textPart?.text.trim() ||
    (typeof rawContent === "string" ? rawContent.trim() : "");
  if (!text) return "New chat";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function findLatestBuilds(messages: ChatUIMessage[], currency: string): DerivedBuild[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const builds = extractBuildsFromMessage(msg, currency);
      if (builds.length > 0) return builds;
    }
  }
  return null;
}

function buildsSignature(builds: DerivedBuild[] | null): string {
  if (!builds || builds.length === 0) return "";
  return builds
    .map(
      (b) =>
        `${b.label || ""}:${b.currency}:${b.components
          .map((c) => `${c.category}:${c.name}:${c.price}`)
          .join(",")}`
    )
    .join("|");
}

function ModelStatus({ modelName, streaming }: { modelName: string; streaming: boolean }) {
  const [dots, setDots] = useState("...");
  const displayName = useMemo(() => formatModelName(modelName), [modelName]);

  useEffect(() => {
    if (!streaming) return;
    const interval = setInterval(() => {
      setDots((prev) => {
        if (prev === "...") return ".";
        if (prev === ".") return "..";
        if (prev === "..") return "...";
        return "...";
      });
    }, 500);
    return () => clearInterval(interval);
  }, [streaming]);

  return (
    <div
      className="flex items-center gap-2 text-sm font-medium text-text-muted select-none min-w-0 max-w-[240px] sm:max-w-xs md:max-w-md"
      title={modelName ? `Model: ${modelName}` : undefined}
    >
      <span
        className={`h-2 w-2 rounded-full shrink-0 ${streaming ? "animate-pulse" : ""}`}
        style={{
          backgroundColor: "#10b981",
          boxShadow: streaming ? "0 0 8px #10b981" : undefined
        }}
      />
      <span className="font-mono text-caption text-text-muted truncate">
        <span className="text-text-secondary">{displayName}</span> · {streaming ? `thinking${dots}` : "idle"}
      </span>
    </div>
  );
}

export function ChatView({
  config,
  sessionId,
  initialMessages,
  saveQueue,
  onPersisted,
  isActive = true
}: {
  config: ClientConfig;
  sessionId: string;
  initialMessages: ChatUIMessage[];
  saveQueue: SessionSaveQueue;
  onPersisted?: () => void;
  isActive?: boolean;
}) {
  const { setHeaderSuffix, updateConfig } = useApp();
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  });

  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  });

  useEffect(() => {
    saveQueue.setOnPersisted(() => onPersisted?.());
    return () => saveQueue.setOnPersisted(() => {});
  }, [saveQueue, onPersisted]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 60;
    isAtBottomRef.current = isAtBottom;
  };

  const [dbStatus, setDbStatus] = useState<StatusResponse | null>(null);

  useEffect(() => {
    fetchStatus()
      .then(setDbStatus)
      .catch(() => setDbStatus(null));
  }, [config.countryCode]);

  const countryStats = dbStatus?.database?.rowCounts?.find(
    (row) => row.countryCode === config.countryCode
  );
  const lastScraped = countryStats?.lastScraped || dbStatus?.database?.lastScraped || null;

  // Re-render once a minute so the derived label below stays current.
  const [, tickClock] = useReducer((tick: number) => tick + 1, 0);

  useEffect(() => {
    if (!lastScraped) return;
    const interval = setInterval(tickClock, 60000);
    return () => clearInterval(interval);
  }, [lastScraped]);

  const relativeTime = lastScraped ? formatRelativeTime(lastScraped) : "";

  const transport = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- configRef/sessionIdRef are read inside the transport's headers/body callbacks, which run at request time, not during render
      new DefaultChatTransport<ChatUIMessage>({
        api: "/api/chat",
        headers: () => apiKeyHeaders(configRef.current.chatChain, configRef.current),
        body: () => {
          const current = configRef.current;
          return {
            sessionId: sessionIdRef.current,
            config: {
              chatLlmChain: toServerChain(current.chatChain),
              llmChain: toServerChain(current.chatChain),
              ...(current.subagentChain ? { subagentLlmChain: toServerChain(current.subagentChain) } : {}),
              personality: current.personality,
              tier2Enabled: current.tier2Enabled,
              freeformConsultEnabled: current.freeformConsultEnabled,
              countryCode: current.countryCode,
              currency: current.currency,
              searchProvider: current.searchProvider,
              searchBaseUrl: current.searchBaseUrl,
              crawlEnabled: current.crawlEnabled
            }
          };
        }
      }),
    []
  );

  const { messages, sendMessage, status, stop, error, setMessages } = useChat<ChatUIMessage>({
    id: sessionId,
    messages: initialMessages,
    transport
  });

  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [activeBuilds, setActiveBuilds] = useState<DerivedBuild[] | null>(null);
  const [panelWidth, setPanelWidth] = useState(460);
  const [isDragging, setIsDragging] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    const startX = e.clientX;
    const startWidth = panelWidth;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = startX - moveEvent.clientX;
      const minWidth = 360;
      const maxWidth = Math.min(880, window.innerWidth * 0.65);
      const newWidth = Math.min(Math.max(startWidth + delta, minWidth), maxWidth);
      setPanelWidth(newWidth);
    };

    const onMouseUp = () => {
      setIsDragging(false);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [panelWidth]);

  const isDesktop = useIsDesktop(1024);

  const latestBuilds = useMemo(
    () => findLatestBuilds(messages, config.currency),
    [messages, config.currency]
  );

  const displayBuilds = activeBuilds ?? latestBuilds;

  const lastSigRef = useRef<string>("");

  useEffect(() => {
    const currentSig = buildsSignature(latestBuilds);
    if (latestBuilds && currentSig && currentSig !== lastSigRef.current) {
      lastSigRef.current = currentSig;
      queueMicrotask(() => {
        setActiveBuilds(latestBuilds);
        if (isActive && typeof window !== "undefined" && window.innerWidth >= 1024) {
          setSidePanelOpen(true);
        }
      });
    }
  }, [latestBuilds, isActive]);

  const streaming = status === "streaming" || status === "submitted";
  const lastAssistantMessage = [...messages].reverse().find((m) => m.role === "assistant");
  const activeModel = lastAssistantMessage?.metadata?.model || config.chatChain?.[0]?.model || "Sage";

  const primaryBuild = displayBuilds?.[0];
  const headerBuildPrice = primaryBuild
    ? formatPrice(
        sumPrices(primaryBuild.components.map((c) => c.price)),
        primaryBuild.currency
      )
    : null;

  useEffect(() => {
    if (!isActive) return;
    setHeaderSuffix(
      <div className="flex flex-1 items-center justify-between gap-3 min-w-0">
        <ModelStatus modelName={activeModel} streaming={streaming} />
        {displayBuilds && displayBuilds.length > 0 && headerBuildPrice ? (
          <button
            type="button"
            onClick={() => {
              if (!sidePanelOpen && !activeBuilds && latestBuilds) {
                setActiveBuilds(latestBuilds);
              }
              setSidePanelOpen((prev) => !prev);
            }}
            aria-expanded={sidePanelOpen}
            aria-label={
              sidePanelOpen
                ? "Close proposed build panel"
                : "Open proposed build panel"
            }
            className={cn(
              "inline-flex items-center gap-1.5 rounded-btn px-2.5 py-1 text-caption font-medium transition-colors duration-150 border cursor-pointer select-none shrink-0",
              sidePanelOpen
                ? "border-accent bg-accent/10 text-accent font-semibold"
                : "border-border bg-surface text-text hover:border-accent hover:text-accent"
            )}
          >
            <Icon icon={Package} size={14} className="shrink-0" />
            <span className="truncate">Proposed Build ({headerBuildPrice})</span>
          </button>
        ) : null}
      </div>
    );
    return () => {
      if (isActive) {
        setHeaderSuffix(null);
      }
    };
  }, [
    isActive,
    setHeaderSuffix,
    activeModel,
    streaming,
    displayBuilds,
    headerBuildPrice,
    sidePanelOpen,
    activeBuilds,
    latestBuilds
  ]);

  useEffect(() => {
    if (!isActive) return;
    const el = scrollRef.current;
    if (!el) return;

    const lastMessage = messages.at(-1);
    const isLastMessageUser = lastMessage?.role === "user";

    if (isLastMessageUser || isAtBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages, streaming, isActive]);

  const persistSnapshot = useCallback(
    (currentMessages: ChatUIMessage[]) => {
      if (currentMessages.length === 0) return;
      const signature = sessionSignature(currentMessages);

      void saveQueue.enqueue(signature, {
        id: sessionIdRef.current,
        messages: currentMessages,
        title: deriveTitle(currentMessages),
        countryCode: configRef.current.countryCode,
        currency: configRef.current.currency
      });
    },
    [saveQueue]
  );

  // Persist the full UIMessage[] to the sessions store after each completed turn or state change.
  useEffect(() => {
    if (status !== "ready" || messages.length === 0) return;
    persistSnapshot(messages);
  }, [status, messages, persistSnapshot]);

  // Keep a ref to latest messages for unmount saving so no state is ever lost.
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    return () => {
      if (messagesRef.current.length > 0) {
        const msgs = messagesRef.current;
        const signature = sessionSignature(msgs);
        void saveQueue.enqueue(signature, {
          id: sessionIdRef.current,
          messages: msgs,
          title: deriveTitle(msgs),
          countryCode: configRef.current.countryCode,
          currency: configRef.current.currency
        });
      }
    };
  }, [saveQueue]);

  const send = (text: string) => {
    sendMessage({ text });
    const userMsg: ChatUIMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text }]
    };
    persistSnapshot([...messages, userMsg]);
  };

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] w-full overflow-hidden">
      {/* Left / Center: Chat messages & composer */}
      <div className="flex flex-1 flex-col min-w-0 h-full">
        <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[760px] px-4 pb-6">
            {messages.length === 0 ? (
              <ChatEmptyState onPick={send} />
            ) : (
              <div className="flex flex-col gap-6 pt-6">
                {messages.map((message, index) => (
                  <MessageView
                    key={message.id || `msg-${index}`}
                    message={message}
                    currency={config.currency}
                    onViewBuild={(builds) => {
                      setActiveBuilds(builds);
                      setSidePanelOpen(true);
                    }}
                    onEdit={
                      !streaming && message.role === "user"
                        ? (newText) => {
                            const truncated = messages.slice(0, index);
                            setMessages(truncated);
                            sendMessage({ text: newText });
                            const editedUserMsg: ChatUIMessage = {
                              id: crypto.randomUUID(),
                              role: "user",
                              parts: [{ type: "text", text: newText }]
                            };
                            persistSnapshot([...truncated, editedUserMsg]);
                          }
                        : undefined
                    }
                  />
                ))}
                {status === "submitted" ? (
                  <p className="text-caption text-text-muted" role="status">
                    The sage is thinking…
                  </p>
                ) : null}
              </div>
            )}

            {error ? (
              <div
                className="mt-4 flex items-start gap-2 rounded-card border px-4 py-3 text-sm"
                style={{
                  color: "var(--warn)",
                  borderColor: "color-mix(in srgb, var(--warn) 45%, transparent)",
                  backgroundColor: "color-mix(in srgb, var(--warn) 8%, transparent)"
                }}
                role="alert"
              >
                <Icon icon={TriangleAlert} size={16} className="mt-0.5 shrink-0" />
                <span className="flex-1 whitespace-pre-wrap leading-relaxed">
                  {getErrorMessage(error)}
                </span>
              </div>
            ) : null}
          </div>
        </div>

        <div className="border-t border-border bg-bg shrink-0">
          <div className="mx-auto w-full max-w-[760px] px-4 py-3">
            <Composer onSend={send} onStop={stop} streaming={streaming} />
            <p className="mt-2 text-center text-caption text-text-muted">
              Prices are live from your local database{relativeTime ? ` (last updated ${relativeTime})` : ""}. Compatibility is checked deterministically.{" "}
              <button
                type="button"
                onClick={() => updateConfig({ onboarded: false })}
                className="ml-1 cursor-pointer font-medium text-accent hover:underline"
              >
                Update prices
              </button>
            </p>
          </div>
        </div>
      </div>

      {/* Desktop Right Side Panel Splitter & Aside */}
      {sidePanelOpen && displayBuilds && displayBuilds.length > 0 ? (
        <>
          {/* Clean Draggable Splitter Area (no visible handle artifact) */}
          <div
            onMouseDown={startResizing}
            onDoubleClick={() => {
              setPanelWidth(460);
              setIsExpanded(false);
            }}
            title="Drag to resize panel (double-click to reset)"
            className={cn(
              "hidden lg:block w-1.5 -ml-1.5 shrink-0 cursor-col-resize relative select-none z-10 hover:bg-accent/30 active:bg-accent transition-colors duration-150",
              isDragging && "bg-accent"
            )}
          />

          <aside
            style={{ width: `${panelWidth}px` }}
            className={cn(
              "hidden lg:flex shrink-0 flex-col border-l border-border bg-surface h-full overflow-hidden",
              !isDragging && "transition-[width] duration-150 ease-out",
              isDragging && "select-none"
            )}
            aria-label="Proposed build panel"
          >
            <div className="flex h-12 items-center justify-between border-b border-border px-4 shrink-0 bg-surface">
              <div className="flex items-center gap-2 min-w-0">
                <Icon icon={Package} size={18} className="text-accent shrink-0" />
                <h2 className="text-sm font-semibold text-text truncate">Proposed Build</h2>
                {displayBuilds.length > 1 ? (
                  <span className="rounded-pill bg-surface-raised px-2 py-0.5 text-caption font-medium text-text-secondary shrink-0">
                    {displayBuilds.length} options
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setIsExpanded((prev) => {
                      if (!prev) {
                        setPanelWidth(Math.min(740, window.innerWidth * 0.55));
                      } else {
                        setPanelWidth(460);
                      }
                      return !prev;
                    });
                  }}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-btn text-text-secondary transition-colors duration-150 hover:bg-surface-raised hover:text-text cursor-pointer shrink-0"
                  aria-label={isExpanded ? "Restore standard width" : "Expand panel width"}
                  title={isExpanded ? "Restore standard width" : "Expand panel width"}
                >
                  <Icon icon={isExpanded ? Minimize2 : Maximize2} size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => setSidePanelOpen(false)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-btn text-text-secondary transition-colors duration-150 hover:bg-surface-raised hover:text-text cursor-pointer shrink-0"
                  aria-label="Close build panel"
                  title="Close build panel"
                >
                  <Icon icon={X} size={16} />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              <BuildCard builds={displayBuilds} inSidePanel />
            </div>
          </aside>
        </>
      ) : null}

      {/* Mobile/Tablet Slide-over Drawer / Sheet */}
      <Sheet open={sidePanelOpen && !isDesktop && Boolean(displayBuilds?.length)} onOpenChange={setSidePanelOpen}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-md bg-surface p-0 flex flex-col h-full border-l border-border"
        >
          <SheetHeader className="h-14 flex-row items-center justify-between border-b border-border px-4 py-0 shrink-0 pr-12">
            <div className="flex items-center gap-2 min-w-0">
              <Icon icon={Package} size={18} className="text-accent shrink-0" />
              <SheetTitle className="text-sm font-semibold text-text truncate">Proposed Build</SheetTitle>
              {displayBuilds && displayBuilds.length > 1 ? (
                <span className="rounded-pill bg-surface-raised px-2 py-0.5 text-caption font-medium text-text-secondary shrink-0">
                  {displayBuilds.length} options
                </span>
              ) : null}
            </div>
            <SheetDescription className="sr-only">
              Proposed PC build components, prices, and compatibility verification
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-4">
            {displayBuilds && <BuildCard builds={displayBuilds} inSidePanel />}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
