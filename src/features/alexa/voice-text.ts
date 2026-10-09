/**
 * src/features/alexa/voice-text.ts
 *
 * Pure text helpers for the /alexa voice page: assistant text extraction
 * (what gets spoken and shown large) and the short-transcript window.
 */

import { isToolPartLike } from "./present-cards";

interface PartLike {
  type?: unknown;
  text?: unknown;
}

interface MessageLike {
  id?: string;
  role?: string;
  content?: unknown;
  parts?: unknown;
}

/** Plain text of one UI message, joining its text parts. */
export function messageText(message: MessageLike | null | undefined): string {
  if (!message) return "";
  const parts = Array.isArray(message.parts)
    ? message.parts
    : typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : [];
  return (parts as PartLike[])
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim();
}

/**
 * The answer of one assistant message: the text of its last step. A tool turn
 * streams a preamble before each call ("Let me check the catalog…"); only the
 * text after the last tool call is the answer. While that final step hasn't
 * produced text yet, this is the latest step's text.
 */
export function answerText(message: MessageLike | null | undefined): string {
  if (!message || !Array.isArray(message.parts)) return messageText(message);
  let step: string[] = [];
  let latest = "";
  for (const part of message.parts as PartLike[]) {
    if (isToolPartLike(part)) {
      step = [];
    } else if (part?.type === "text" && typeof part.text === "string") {
      step.push(part.text);
      const text = step.join("\n").trim();
      if (text) latest = text;
    }
  }
  return latest;
}

function isAssistantText(message: MessageLike): boolean {
  return message?.role === "assistant" && messageText(message).length > 0;
}

/** Answer of the latest assistant message (the current answer). */
export function latestAssistantText(messages: MessageLike[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = answerText(messages[i]);
    if (messages[i]?.role === "assistant" && text.length > 0) return text;
  }
  return "";
}

/**
 * The short transcript: the last few turns before the current answer,
 * oldest-first. Turns with no speakable text are dropped, and a trailing
 * assistant message (the current answer) is excluded — it renders large.
 */
export function shortTranscript(messages: MessageLike[], maxMessages = 6): MessageLike[] {
  const withText = messages.filter(
    (message) =>
      (message?.role === "user" || message?.role === "assistant") && messageText(message).length > 0
  );
  const withoutCurrentAnswer =
    withText.length > 0 && withText[withText.length - 1]?.role === "assistant"
      ? withText.slice(0, -1)
      : withText;
  return withoutCurrentAnswer.slice(-maxMessages);
}

/** True when at least one assistant turn has speakable text. */
export function hasAssistantReply(messages: MessageLike[]): boolean {
  return messages.some(isAssistantText);
}
