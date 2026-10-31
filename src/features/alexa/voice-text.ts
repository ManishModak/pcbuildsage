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

/**
 * The current turn's answer: the newest message's answer when it is from the
 * assistant. When the newest message is the user's, a new turn is pending and
 * there is no answer yet (an older turn's text would be stale).
 */
export function currentTurnAnswer(messages: MessageLike[]): string {
  const last = messages.at(-1);
  return last?.role === "assistant" ? answerText(last) : "";
}

/** Said when a turn presents builds but ends without any text. */
export const CARD_ONLY_REPLY = "I've put the builds on the card.";

/** Plain text for speech: drops markdown syntax, links, code and table rows. */
export function plainSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|[-*+•]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s.,;:!?)]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Longest closing question kept on top of the summary's word budget. */
const MAX_QUESTION_WORDS = 25;

/**
 * What the voice says and shows large: the answer's first sentences, up to
 * about `maxWords` words (always at least the first sentence, trimmed at a
 * clause break if it alone runs long), plus the closing question when the
 * answer ends with a short one, since that keeps the voice conversation going.
 * Small local models ignore the "two sentences" prompt rule, so brevity is
 * enforced here; the full answer stays available on screen.
 */
export function spokenSummary(answer: string, maxWords = 40): string {
  const plain = plainSpeech(answer);
  if (!plain) return "";
  // A sentence ends at . ! ? before a capital or quote, so "Rs. 21,645" and
  // "2.5 GHz" don't split.
  const sentences = plain.split(/(?<=[.!?])\s+(?=[A-Z"'“(])/);
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  const last = sentences[sentences.length - 1];
  const question = sentences.length > 1 && last.endsWith("?") && words(last) <= MAX_QUESTION_WORDS ? last : "";
  const lead = question ? sentences.slice(0, -1) : sentences;
  let summary = lead[0];
  for (const next of lead.slice(1)) {
    if (words(summary) + words(next) > maxWords) break;
    summary = `${summary} ${next}`;
  }
  if (words(summary) > maxWords * 1.5) {
    const head = summary.split(/\s+/).slice(0, maxWords).join(" ");
    const clause = Math.max(head.lastIndexOf(","), head.lastIndexOf(";"), head.lastIndexOf(" —"));
    summary = `${(clause >= head.length / 3 ? head.slice(0, clause) : head).replace(/[,;:—\s]+$/, "")}.`;
  }
  return question ? `${summary} ${question}` : summary;
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
