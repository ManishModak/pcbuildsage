"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { fetchPersonas } from "../lib/api";
import { apiKeyHeaders, toServerChain } from "../lib/config-store";
import type { ClientConfig, Persona } from "../lib/types";
import { Icon } from "../ui/icon";
import { Composer } from "./composer";
import { ChatEmptyState } from "./empty-state";
import { MessageView, type ChatUIMessage } from "./message";

export function ChatView({ config }: { config: ClientConfig }) {
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  });

  const [personas, setPersonas] = useState<Persona[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchPersonas().then(setPersonas).catch(() => setPersonas([]));
  }, []);

  const transport = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- configRef is read inside the transport's headers/body callbacks, which run at request time, not during render
      new DefaultChatTransport<ChatUIMessage>({
        api: "/api/chat",
        headers: () => apiKeyHeaders(configRef.current.chatChain),
        body: () => {
          const current = configRef.current;
          return {
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
              currency: current.currency
            }
          };
        }
      }),
    []
  );

  const { messages, sendMessage, status, stop, error } = useChat<ChatUIMessage>({ transport });

  const streaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streaming]);

  const personaLabels = useMemo(() => {
    const byId = new Map(personas.map((persona) => [persona.id, persona.persona_name]));
    return config.personas.map((id) => byId.get(id) ?? id);
  }, [personas, config.personas]);

  const send = (text: string) => sendMessage({ text });

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-4 pb-6">
          {messages.length === 0 ? (
            <ChatEmptyState onPick={send} />
          ) : (
            <div className="flex flex-col gap-6 pt-6">
              {messages.map((message) => (
                <MessageView
                  key={message.id}
                  message={message}
                  personaLabels={personaLabels}
                  currency={config.currency}
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
              <Icon icon={TriangleAlert} size={16} />
              <span>
                Something interrupted the response. Check your provider chain in settings and try again.
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
