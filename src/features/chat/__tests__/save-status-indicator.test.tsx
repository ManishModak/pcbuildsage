import { describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/api-client";
import { SessionSaveQueue, sessionSignature } from "../session-save-queue";
import { shouldShowNotSavedYet } from "../save-failure-notice";
import type { ChatUIMessage } from "../message";

/**
 * The "Not saved yet" header rule. The header itself is published through an
 * effect (`setHeaderSuffix`), which no server-render test can observe, so the
 * rule lives in a pure helper and is asserted here - including end to end from
 * a real queue that just failed a save.
 *
 * No `useChat` stand-in appears here on purpose: a previous fake re-read
 * `messages` on every render, which hid a data-loss bug. This rule takes plain
 * values, so there is nothing a hook could misbehave about.
 */

const noSleep = () => Promise.resolve();

function userMessage(text: string): ChatUIMessage {
  return { id: `m-${text}`, role: "user", parts: [{ type: "text", text }] } as ChatUIMessage;
}

describe("shouldShowNotSavedYet", () => {
  it("shows while a real queue holds a 5xx failure for retry", async () => {
    const messages = [userMessage("hello")];
    const persist = vi.fn().mockRejectedValue(new HttpError("server on fire", 500, null));
    const queue = new SessionSaveQueue(persist, "initial", 0, () => {}, { sleep: noSleep });

    await queue.enqueue("unsaved-transcript", {
      id: "session-1",
      messages: messages.map((m) => ({ id: m.id, role: m.role, parts: [] }))
    });

    // The save did not land and was kept, not dropped.
    expect(queue.hasUnsaved()).toBe(true);
    expect(
      shouldShowNotSavedYet({
        messageCount: messages.length,
        saveFailureNotice: null,
        queueUnsaved: queue.hasUnsaved(),
        settledUnacknowledged: true
      })
    ).toBe(true);
  });

  it("hides once the transcript is acknowledged", () => {
    const messages = [userMessage("hello")];
    const queue = new SessionSaveQueue(async () => {}, sessionSignature(messages), 0, () => {}, {
      sleep: noSleep
    });

    expect(
      shouldShowNotSavedYet({
        messageCount: messages.length,
        saveFailureNotice: null,
        queueUnsaved: queue.hasUnsaved(),
        settledUnacknowledged: !queue.isAcknowledged(sessionSignature(messages))
      })
    ).toBe(false);
  });

  it("stays hidden for an empty or loading chat, however unsaved the queue", () => {
    const shown = {
      saveFailureNotice: null,
      queueUnsaved: true,
      settledUnacknowledged: true
    };
    expect(shouldShowNotSavedYet({ ...shown, messageCount: 0 })).toBe(false);
    expect(shouldShowNotSavedYet({ ...shown, messageCount: 2, isLoading: true })).toBe(false);
  });

  it("shows on a failure notice even when the queue looks settled", () => {
    expect(
      shouldShowNotSavedYet({
        messageCount: 3,
        saveFailureNotice: "This chat couldn't be saved just now.",
        queueUnsaved: false,
        settledUnacknowledged: false
      })
    ).toBe(true);
  });
});
