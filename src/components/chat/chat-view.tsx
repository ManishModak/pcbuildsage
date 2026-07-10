"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { fetchPersonas, saveSession } from "../lib/api";
import { apiKeyHeaders, toServerChain } from "../lib/config-store";
import type { ClientConfig, Persona } from "../lib/types";
import { Icon } from "../ui/icon";
import { Composer } from "./composer";
import { ChatEmptyState } from "./empty-state";
import { MessageView, type ChatUIMessage } from "./message";
import { useApp } from "../app/app-provider";

function signatureOf(messages: ChatUIMessage[]): string {
  return `${messages.length}:${messages.at(-1)?.id ?? ""}`;
}

function deriveTitle(messages: ChatUIMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  const textPart = firstUser?.parts.find(
    (part): part is { type: "text"; text: string } =>
      part.type === "text" && typeof (part as { text?: unknown }).text === "string"
  );
  const text = textPart?.text.trim();
  if (!text) return "New chat";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function getErrorMessage(error: Error): string {
  if (!error.message) {
    return "Something interrupted the response. Check your provider chain in settings and try again.";
  }

  try {
    const parsed = JSON.parse(error.message);
    if (parsed && typeof parsed === "object") {
      if (parsed.message) return String(parsed.message);
      if (parsed.error && typeof parsed.error === "object" && parsed.error.message) {
        return String(parsed.error.message);
      }
      if (typeof parsed.error === "string") return parsed.error;
    }
  } catch {
    // Ignore
  }

  const jsonStart = error.message.indexOf("{");
  const jsonEnd = error.message.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
    try {
      const jsonSub = error.message.slice(jsonStart, jsonEnd + 1);
      const parsed = JSON.parse(jsonSub);
      if (parsed && typeof parsed === "object") {
        if (parsed.message) return String(parsed.message);
        if (parsed.error && typeof parsed.error === "object" && parsed.error.message) {
          return String(parsed.error.message);
        }
        if (typeof parsed.error === "string") return parsed.error;
      }
    } catch {
      // Ignore
    }
  }

  return error.message;
}

function ModelStatus({ modelName, streaming }: { modelName: string; streaming: boolean }) {
  const [dots, setDots] = useState("...");

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
    <div className="flex items-center gap-2 text-sm font-medium text-text-muted select-none">
      <span
        className={`h-2 w-2 rounded-full ${streaming ? "animate-pulse" : ""}`}
        style={{
          backgroundColor: "#10b981",
          boxShadow: streaming ? "0 0 8px #10b981" : undefined
        }}
      />
      <span className="font-mono text-caption text-text-muted">
        {modelName} · {streaming ? `thinking${dots}` : "idle"}
      </span>
    </div>
  );
}

export function ChatView({
  config,
  sessionId,
  initialMessages,
  onPersisted
}: {
  config: ClientConfig;
  sessionId: string;
  initialMessages: ChatUIMessage[];
  onPersisted?: () => void;
}) {
  const { setHeaderSuffix } = useApp();
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  });

  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  });

  const [personas, setPersonas] = useState<Persona[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 60;
    isAtBottomRef.current = isAtBottom;
  };

  useEffect(() => {
    fetchPersonas().then(setPersonas).catch(() => setPersonas([]));
  }, []);

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
              persona: current.personas[0],
              personas: current.personas,
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

  const streaming = status === "streaming" || status === "submitted";
  const lastAssistantMessage = [...messages].reverse().find((m) => m.role === "assistant");
  const activeModel = lastAssistantMessage?.metadata?.model || config.chatChain?.[0]?.model || "Sage";

  useEffect(() => {
    setHeaderSuffix(<ModelStatus modelName={activeModel} streaming={streaming} />);
    return () => {
      setHeaderSuffix(null);
    };
  }, [setHeaderSuffix, activeModel, streaming]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const lastMessage = messages.at(-1);
    const isLastMessageUser = lastMessage?.role === "user";

    if (isLastMessageUser || isAtBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages, streaming]);

  // Persist the full UIMessage[] to the sessions store after each completed turn.
  // Guard against re-saving the untouched initial state (mere viewing) via a signature.
  const lastPersistedRef = useRef(signatureOf(initialMessages));
  useEffect(() => {
    if (status !== "ready" || messages.length === 0) return;
    const signature = signatureOf(messages);
    if (signature === lastPersistedRef.current) return;

    const timer = setTimeout(() => {
      lastPersistedRef.current = signature;
      void saveSession({
        id: sessionIdRef.current,
        messages,
        title: deriveTitle(messages),
        countryCode: configRef.current.countryCode,
        currency: configRef.current.currency
      })
        .then(() => onPersisted?.())
        .catch(() => {
          // A failed persist must not interrupt the chat; the next turn retries.
        });
    }, 500);

    return () => clearTimeout(timer);
  }, [status, messages, onPersisted]);

  const personaLabels = useMemo(() => {
    const byId = new Map(personas.map((persona) => [persona.id, persona.persona_name]));
    return config.personas.map((id) => byId.get(id) ?? id);
  }, [personas, config.personas]);

  const send = (text: string) => sendMessage({ text });

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col">
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-4 pb-6">
          {messages.length === 0 ? (
            <ChatEmptyState onPick={send} />
          ) : (
            <div className="flex flex-col gap-6 pt-6">
              {messages.map((message, index) => (
                <MessageView
                  key={message.id}
                  message={message}
                  personaLabels={personaLabels}
                  currency={config.currency}
                  onEdit={
                    !streaming && message.role === "user"
                      ? (newText) => {
                          const truncated = messages.slice(0, index);
                          setMessages(truncated);
                          sendMessage({ text: newText });
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

      <div className="border-t border-border bg-bg">
        <div className="mx-auto w-full max-w-[760px] px-4 py-3">
          <Composer onSend={send} onStop={stop} streaming={streaming} />
          <p className="mt-2 text-center text-caption text-text-muted">
            Prices are live from your local database. Compatibility is checked deterministically.
          </p>
        </div>
      </div>
    </div>
  );
}
