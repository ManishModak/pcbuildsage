import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CONFLICT_ADOPTED_NOTICE,
  describeSaveFailure,
  GENERIC_SAVE_FAILURE_NOTICE,
  NO_DURABLE_STORAGE_NOTICE,
  SESSION_DELETED_NOTICE,
  SaveAlert
} from "../save-failure-notice";
import {
  KeepaliveTooLargeError,
  KEEPALIVE_BODY_LIMIT_BYTES
} from "@/lib/api-client";
import { SessionConflictError, SessionPersistenceError } from "@/lib/sessions/client-store";

/**
 * The four ways a save can fail mean different things and need different words. A
 * single hardcoded string was wrong for three of them, and none of the strings
 * were asserted anywhere.
 */

describe("describeSaveFailure", () => {
  it("says storage is unavailable when the browser has none", () => {
    const notice = describeSaveFailure(
      new SessionPersistenceError("no_durable_storage", "This browser blocked localStorage.")
    );
    expect(notice).toBe(NO_DURABLE_STORAGE_NOTICE);
    expect(notice).toContain("close or reload");
  });

  it("names the remedy when storage is full, instead of blaming missing storage", () => {
    const failure = new SessionPersistenceError(
      "quota_exceeded",
      "Browser storage is full, so this chat was not saved. Delete an older chat and try again."
    );
    const notice = describeSaveFailure(failure);

    expect(notice).toBe("Browser storage is full, so this chat was not saved. Delete an older chat and try again.");
    expect(notice).not.toContain("isn't letting this site store anything");
    // The previous behaviour said storage was unavailable, which is not what happened.
    expect(notice).not.toBe(NO_DURABLE_STORAGE_NOTICE);
  });

  it("falls back to the generic wording if a quota error carries no message", () => {
    const failure = Object.assign(new Error(""), {
      isSessionPersistenceError: true,
      reason: "quota_exceeded"
    });
    expect(describeSaveFailure(failure)).toBe(GENERIC_SAVE_FAILURE_NOTICE);
  });

  it("explains a deleted chat when a save tried to recreate it", () => {
    const notice = describeSaveFailure(new SessionConflictError("session_deleted", null, "Session x was deleted."));
    expect(notice).toBe(SESSION_DELETED_NOTICE);
  });

  it("stays silent for an oversize keepalive flush: nothing is actually wrong", () => {
    const notice = describeSaveFailure(
      new KeepaliveTooLargeError("session-1", KEEPALIVE_BODY_LIMIT_BYTES * 9)
    );
    // Storage is fine and the throttle is still saving; a banner here would be a
    // false alarm, repeated on every tab switch.
    expect(notice).toBeNull();
  });

  it("uses the generic wording for a revision conflict and for anything unknown", () => {
    expect(describeSaveFailure(new SessionConflictError("stale_revision", 9, "stale"))).toBe(
      GENERIC_SAVE_FAILURE_NOTICE
    );
    expect(describeSaveFailure(new Error("network on fire"))).toBe(GENERIC_SAVE_FAILURE_NOTICE);
    expect(describeSaveFailure(null)).toBe(GENERIC_SAVE_FAILURE_NOTICE);
    expect(describeSaveFailure("nope")).toBe(GENERIC_SAVE_FAILURE_NOTICE);
  });
});

describe("the notice banner", () => {
  const everyNotice = [
    NO_DURABLE_STORAGE_NOTICE,
    SESSION_DELETED_NOTICE,
    GENERIC_SAVE_FAILURE_NOTICE,
    CONFLICT_ADOPTED_NOTICE
  ];

  /** React escapes these in text content, so compare against the decoded string. */
  function decode(markup: string): string {
    return markup
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }

  it.each(everyNotice)("announces itself as an alert: %s", (notice) => {
    const markup = renderToStaticMarkup(<SaveAlert message={notice} />);
    expect(markup).toContain('role="alert"');
    expect(decode(markup)).toContain(notice);
  });

  it("shows exactly the message it is given", () => {
    const markup = decode(renderToStaticMarkup(<SaveAlert message={NO_DURABLE_STORAGE_NOTICE} />));
    expect(markup).not.toContain(SESSION_DELETED_NOTICE);
    expect(markup).not.toContain(CONFLICT_ADOPTED_NOTICE);
  });
});
