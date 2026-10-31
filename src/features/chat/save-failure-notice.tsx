"use client";

import { TriangleAlert } from "lucide-react";
import { Icon } from "@/components/ui/icon";

/**
 * Turning a failed session save into something worth showing a person.
 *
 * The ways a save can fail are genuinely different problems with genuinely
 * different remedies, so they get different words. A single hardcoded string was
 * wrong for most of them - most visibly, telling someone their chat "will be lost"
 * when storage is fine and the 5-second throttle is still writing.
 */

/** Shown when the browser has no storage available at all for this site. */
export const NO_DURABLE_STORAGE_NOTICE =
  "This browser isn't letting this site store anything, so this chat can't be saved here. It will be lost when you close or reload the tab.";

/** Shown when the chat was deleted and a save tried to bring it back. */
export const SESSION_DELETED_NOTICE =
  "This chat was deleted, so it can't be saved. Anything you type now starts a new chat.";

/** Last resort for a failure we do not recognise. */
export const GENERIC_SAVE_FAILURE_NOTICE =
  "This chat couldn't be saved just now. If it keeps happening, exporting the transcript is the safest copy.";

export const CONFLICT_ADOPTED_NOTICE =
  "This chat was updated in another tab, so that newer version was loaded here. Your unsaved changes were not sent.";

/**
 * The banner a save-failure or conflict notice renders in. Exported so the copy
 * and the `role="alert"` contract can be asserted against real markup.
 */
export function SaveAlert({ message }: { message: string }) {
  return (
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
      <span className="flex-1 whitespace-pre-wrap leading-relaxed">{message}</span>
    </div>
  );
}

type SaveFailure = {
  isSessionPersistenceError?: boolean;
  isSessionConflict?: boolean;
  isKeepaliveTooLarge?: boolean;
  reason?: string;
  message?: string;
};

function asSaveFailure(error: unknown): SaveFailure | null {
  return typeof error === "object" && error !== null ? (error as SaveFailure) : null;
}

/**
 * The notice to show for a failed save, or `null` when the failure is nobody's
 * problem and must stay silent.
 *
 * A keepalive flush that exceeded the 64 KiB limit returns `null`: storage is
 * working, the conversation is saved on the ordinary throttle, and the only thing
 * that failed is a request the browser could never have made from an unloading
 * page. Warning about it would be a false alarm on every tab switch.
 */
export function describeSaveFailure(error: unknown): string | null {
  const failure = asSaveFailure(error);
  if (!failure) return GENERIC_SAVE_FAILURE_NOTICE;
  if (failure.isKeepaliveTooLarge) return null;

  if (failure.isSessionConflict) {
    return failure.reason === "session_deleted" ? SESSION_DELETED_NOTICE : GENERIC_SAVE_FAILURE_NOTICE;
  }

  if (failure.isSessionPersistenceError) {
    if (failure.reason === "no_durable_storage") return NO_DURABLE_STORAGE_NOTICE;
    if (failure.reason === "quota_exceeded") {
      // The store's own wording already names the remedy; prefer it over inventing
      // a second phrasing that would drift out of step with it.
      return failure.message?.trim() || GENERIC_SAVE_FAILURE_NOTICE;
    }
  }

  return GENERIC_SAVE_FAILURE_NOTICE;
}

/**
 * Whether the chat header should show "Not saved yet".
 *
 * Pure so the rule is unit-testable: the header itself is published through an
 * effect (`setHeaderSuffix`), which no server-render test can observe. The
 * view passes the live queue readings in; the rule stays here next to the
 * other save-status wording.
 *
 * - `queueUnsaved`: the queue still holds something (`hasUnsaved`) - a snapshot
 *   waiting behind an in-flight request, a conflict held back while streaming,
 *   or a transient failure kept for retry.
 * - `settledUnacknowledged`: the turn is over (`!streaming`) and the queue has
 *   not acknowledged this transcript. While streaming the signature is
 *   perpetually new, so this waits until the turn ends instead of flickering.
 */
export function shouldShowNotSavedYet(options: {
  messageCount: number;
  isLoading?: boolean;
  saveFailureNotice: string | null;
  queueUnsaved: boolean;
  settledUnacknowledged: boolean;
}): boolean {
  return (
    options.messageCount > 0 &&
    !options.isLoading &&
    (options.saveFailureNotice !== null || options.queueUnsaved || options.settledUnacknowledged)
  );
}
