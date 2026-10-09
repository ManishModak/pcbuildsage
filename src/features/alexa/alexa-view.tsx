/**
 * src/features/alexa/alexa-view.tsx
 *
 * The /alexa voice page ("Alexa on a screen"): push-to-talk mic with
 * transcript captions, spoken replies, a short transcript with the current
 * answer large, and the MCP build card below. Consumes the AI SDK UI message
 * stream from POST /api/alexa with useChat, exactly like the text chat
 * (contract §2), sending a stable sessionId UUID per conversation
 * (contract §5) and the same BYOK/config headers as /api/chat.
 */
"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mic, Plus, RotateCcw, Send, Settings, Square, Volume2, VolumeX } from "lucide-react";
import Link from "next/link";
import { AppShell } from "@/components/app/app-shell";
import { useApp } from "@/components/app/app-provider";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/components/ui/cn";
import { isHostedMode } from "@/lib/api-client";
import { apiKeyHeaders } from "@/lib/client-config-store";
import { getErrorMessage } from "@/lib/format";
import { injectByokHeaders } from "@/lib/llm/client-byok-store";
import { resolveChatRequestBody } from "@/features/chat/chat-config-resolver";
import { hostedSendBlocked } from "@/features/chat/composer";
import type { ChatUIMessage } from "@/features/chat/message";
import { BuildCardHost } from "./build-card-host";
import { extractPresentedBuilds, hasPresentAttempt } from "./present-cards";
import { useSpeechRecognition } from "./use-speech-recognition";
import { useSpeechSynthesis } from "./use-speech-synthesis";
import { Markdown } from "@/features/chat/markdown";
import {
  answerText,
  CARD_ONLY_REPLY,
  currentTurnAnswer,
  messageText,
  plainSpeech,
  shortTranscript,
  spokenSummary
} from "./voice-text";

/** Press longer than this sends on release (hold-to-talk); shorter is a tap. */
const HOLD_MS = 450;

export function AlexaView() {
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  return (
    <AppShell>
      <AlexaConversation
        key={sessionId}
        sessionId={sessionId}
        onNewConversation={() => setSessionId(crypto.randomUUID())}
      />
    </AppShell>
  );
}

function AlexaConversation({
  sessionId,
  onNewConversation
}: {
  sessionId: string;
  onNewConversation: () => void;
}) {
  const { config } = useApp();
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  });
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  });

  // Same wire format as /api/chat: BYOK headers + resolved body with a
  // stable sessionId (contract §§1, 5-6). Remount per conversation keeps it.
  const transport = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- refs are read in request-time callbacks, not during render
      new DefaultChatTransport<ChatUIMessage>({
        api: "/api/alexa",
        headers: () =>
          injectByokHeaders(apiKeyHeaders(configRef.current.chatChain, configRef.current)) as Record<
            string,
            string
          >,
        body: () => resolveChatRequestBody(configRef.current, sessionIdRef.current, {})
      }),
    []
  );

  const { messages, sendMessage, status, stop, error } = useChat<ChatUIMessage>({
    id: sessionId,
    messages: [],
    transport
  });
  const streaming = status === "streaming" || status === "submitted";
  const streamingRef = useRef(streaming);
  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);
  // Set when the user interrupts generation (mic press / Stop) so the
  // follow-up send isn't dropped and the partial answer isn't spoken.
  const interruptRef = useRef(false);

  // Barge-in on the stream itself: stop generation so the next utterance can
  // go out immediately. No-op unless a stream is actually running.
  const interrupt = useCallback(() => {
    if (streamingRef.current) {
      interruptRef.current = true;
      stop();
    }
  }, [stop]);

  const recognition = useSpeechRecognition();
  const speech = useSpeechSynthesis();
  const [draft, setDraft] = useState("");
  const [sendBlocked] = useState(() => hostedSendBlocked());
  const [hosted] = useState(() => isHostedMode());

  const presentations = useMemo(() => extractPresentedBuilds(messages), [messages]);
  const currentAnswer = useMemo(() => currentTurnAnswer(messages), [messages]);
  // Spoken and shown large: a short summary, whatever length the model wrote.
  // A turn that ends on a card with no text still gets a short spoken reply.
  const lastTurnPresented = useMemo(() => {
    const last = messages.at(-1);
    return last?.role === "assistant" && extractPresentedBuilds([last]).length > 0;
  }, [messages]);
  const spoken = currentAnswer ? spokenSummary(currentAnswer) : !streaming && lastTurnPresented ? CARD_ONLY_REPLY : "";
  const hasMoreDetail = Boolean(currentAnswer) && plainSpeech(currentAnswer) !== spoken;
  const transcript = useMemo(() => shortTranscript(messages), [messages]);
  const awaitingCard = streaming && presentations.length === 0 && hasPresentAttempt(messages);

  const send = useCallback(
    (text: string): boolean => {
      const clean = text.trim();
      // An interrupted stream (mic pressed or Stop hit mid-generation) settles
      // to ready asynchronously; the interrupt flag lets the follow-up send
      // through instead of dropping the utterance on a stale `streaming`.
      if (!clean || (streamingRef.current && !interruptRef.current)) return false;
      interruptRef.current = false;
      speech.stop();
      void sendMessage({ text: clean });
      return true;
    },
    [sendMessage, speech]
  );

  // Speak each finished answer once (barge-in safe: send/mic stop first).
  // An interrupted stream's partial answer is never spoken.
  const spokenRef = useRef<string | null>(null);
  useEffect(() => {
    if (status !== "ready") return;
    if (interruptRef.current) {
      interruptRef.current = false;
      return;
    }
    if (!spoken) return;
    const key = `${sessionId}:${messages.length}:${spoken}`;
    if (spokenRef.current === key) return;
    spokenRef.current = key;
    speech.speak(spoken);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- speak on turn end only
  }, [status, spoken, sessionId]);

  // --- Push-to-talk: hold to talk, tap to toggle ---------------------------
  const pressRef = useRef<{ at: number; toggleOff: boolean } | null>(null);
  const pointerHandledAt = useRef(0);

  const finishUtterance = useCallback(
    (finalText: string) => {
      if (finalText.trim()) send(finalText);
    },
    [send]
  );

  const handlePressDown = useCallback(() => {
    speech.stop(); // barge-in: the sage stops talking when the mic is pressed
    interrupt(); // …and stops generating, so the next utterance isn't dropped
    if (recognition.status === "listening") {
      pressRef.current = { at: Date.now(), toggleOff: true };
    } else {
      pressRef.current = { at: Date.now(), toggleOff: false };
      recognition.start();
    }
  }, [interrupt, recognition, speech]);

  const handlePressUp = useCallback(() => {
    const press = pressRef.current;
    pressRef.current = null;
    if (!press) return;
    pointerHandledAt.current = Date.now();
    const held = Date.now() - press.at >= HOLD_MS;
    if (press.toggleOff || held) {
      finishUtterance(recognition.stop());
    }
    // A short press that started listening is a tap-to-start: keep listening
    // for the second tap (toggleOff path above).
  }, [finishUtterance, recognition]);

  // Keyboard / assistive-tech activation: plain toggle (pointer handlers
  // already covered mouse and touch; ignore the synthetic click after them).
  const handleMicClick = useCallback(() => {
    if (Date.now() - pointerHandledAt.current < 600) return;
    speech.stop();
    interrupt();
    if (recognition.status === "listening") {
      finishUtterance(recognition.stop());
    } else {
      recognition.start();
    }
  }, [finishUtterance, interrupt, recognition, speech]);

  const listening = recognition.status === "listening";
  const liveCaption = listening ? recognition.finalTranscript || recognition.interim : "";

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-3.5rem)] w-full max-w-2xl flex-col px-4 pb-8">
      {/* Page header */}
      <div className="flex items-center justify-between gap-2 pt-5">
        <div>
          <h1 className="text-lg font-semibold text-text">Sage Voice</h1>
          <p className="text-caption text-text-muted">Push to talk — English (India)</p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={speech.toggleMuted}
            aria-pressed={speech.muted}
            aria-label={speech.muted ? "Unmute spoken replies" : "Mute spoken replies"}
            title={speech.muted ? "Unmute spoken replies" : "Mute spoken replies"}
            className="inline-flex h-9 w-9 items-center justify-center rounded-btn border border-border text-text-secondary transition-colors hover:text-text"
          >
            <Icon icon={speech.muted ? VolumeX : Volume2} size={16} />
          </button>
          <Link
            href="/settings?tab=llm"
            aria-label="Voice and API key settings"
            title="Voice and API key settings"
            className="inline-flex h-9 w-9 items-center justify-center rounded-btn border border-border text-text-secondary transition-colors hover:text-text"
          >
            <Icon icon={Settings} size={16} />
          </Link>
          <button
            type="button"
            onClick={onNewConversation}
            className="inline-flex h-9 items-center gap-1.5 rounded-btn border border-border px-3 text-sm font-medium text-text-secondary transition-colors hover:text-text"
          >
            <Icon icon={Plus} size={15} />
            New chat
          </button>
        </div>
      </div>

      {hosted ? (
        <p className="mt-3 rounded-card border border-border bg-surface px-4 py-2.5 text-sm text-text-secondary" role="note">
          Hosted demo — build cards are disabled here. Run the app locally to see
          and hear full builds.
        </p>
      ) : null}
      {sendBlocked ? (
        <p className="mt-3 rounded-card border border-warn/40 bg-warn/10 px-4 py-2.5 text-sm text-text" role="alert">
          Add your API key to continue.{" "}
          <Link href="/settings?tab=llm" className="font-medium text-accent hover:underline">
            BYOK settings
          </Link>
        </p>
      ) : null}

      {/* Current answer, large */}
      <section aria-live="polite" className="mt-5 min-h-24">
        {spoken ? (
          <p className="text-xl leading-relaxed text-text sm:text-2xl">{spoken}</p>
        ) : (
          <p className="text-xl leading-relaxed text-text-muted sm:text-2xl">
            {streaming ? "Listening to the sage…" : "Tap the mic and ask for a PC build."}
          </p>
        )}
        {awaitingCard ? (
          <p className="mt-2 text-sm text-text-muted" role="status">
            Preparing your build card…
          </p>
        ) : null}
        {hasMoreDetail && !streaming ? (
          <details className="mt-3 text-sm text-text-secondary">
            <summary className="cursor-pointer text-text-muted select-none hover:text-text">Full answer</summary>
            <div className="mt-2">
              <Markdown text={currentAnswer} />
            </div>
          </details>
        ) : null}
      </section>

      {/* Mic button */}
      <div className="mt-4 flex flex-col items-center gap-2">
        <button
          type="button"
          aria-label={listening ? "Stop listening" : "Start listening"}
          aria-pressed={listening}
          onPointerDown={handlePressDown}
          onPointerUp={handlePressUp}
          onPointerCancel={handlePressUp}
          onClick={handleMicClick}
          onContextMenu={(event) => event.preventDefault()}
          className={cn(
            "inline-flex h-20 w-20 touch-none items-center justify-center rounded-full border-2 transition-colors duration-150 select-none",
            listening
              ? "border-accent bg-accent text-on-accent"
              : "border-border bg-surface text-text hover:border-accent hover:text-accent"
          )}
        >
          <Icon icon={Mic} size={30} />
        </button>
        <p className="min-h-5 text-center text-sm text-text-secondary" aria-live="polite">
          {listening
            ? liveCaption || "Listening…"
            : recognition.status === "denied"
              ? "Microphone blocked — allow mic access in the browser, or type below."
              : recognition.status === "unsupported"
                ? "Voice input isn't supported in this browser — type below."
                : "Hold or tap to talk"}
        </p>
      </div>

      {/* Typed fallback, always visible */}
      <form
        className="mt-2 flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (sendBlocked) return;
          if (send(draft)) setDraft("");
        }}
      >
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Or type your build question…"
          aria-label="Type your build question"
          className="h-11 min-w-0 flex-1 rounded-btn border border-border bg-surface px-3 text-base text-text outline-none placeholder:text-text-muted focus:border-accent"
        />
        {streaming ? (
          <button
            type="button"
            onClick={() => {
              speech.stop();
              interrupt();
            }}
            aria-label="Stop generating"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-btn border border-border text-text-secondary hover:text-text"
          >
            <Icon icon={Square} size={16} />
          </button>
        ) : (
          <button
            type="submit"
            disabled={sendBlocked || draft.trim().length === 0}
            aria-label="Send message"
            className={cn(
              "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-btn transition-colors",
              draft.trim().length === 0 || sendBlocked
                ? "bg-surface-raised text-text-muted"
                : "bg-accent text-on-accent hover:opacity-90"
            )}
          >
            <Icon icon={Send} size={17} />
          </button>
        )}
      </form>

      {error ? (
        <p className="mt-3 rounded-card border border-warn/40 bg-warn/10 px-4 py-2.5 text-sm text-text" role="alert">
          {getErrorMessage(error)}{" "}
          <button
            type="button"
            onClick={onNewConversation}
            className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
          >
            <Icon icon={RotateCcw} size={13} /> Start over
          </button>
        </p>
      ) : null}

      {/* Build card */}
      {presentations.length > 0 ? (
        <section aria-label="Proposed builds" className="mt-5">
          <BuildCardHost presentations={presentations} />
        </section>
      ) : null}

      {/* Short transcript: last few turns */}
      {transcript.length > 0 ? (
        <section aria-label="Recent conversation" className="mt-6 border-t border-border pt-4">
          <h2 className="text-caption font-medium tracking-wide text-text-muted uppercase">
            Recently
          </h2>
          <ol className="mt-2 flex flex-col gap-2.5">
            {transcript.map((message, index) => (
              <li
                key={message.id ?? `recent-${index}`}
                className={cn(
                  "text-sm leading-relaxed",
                  message.role === "user" ? "text-text-secondary" : "text-text"
                )}
              >
                <span className="mr-1.5 font-medium text-text-muted">
                  {message.role === "user" ? "You" : "Sage"}
                </span>
                {message.role === "assistant" ? spokenSummary(answerText(message)) : messageText(message)}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
