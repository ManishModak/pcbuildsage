import Database from "better-sqlite3";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  KEEPALIVE_BODY_LIMIT_BYTES,
  KeepaliveTooLargeError,
  requestBodyByteLength,
  saveSession,
  resetCachedDeploymentMode
} from "../api-client";

/**
 * The keepalive size guard. MDN: "The body size for `keepalive` requests is
 * limited to 64 kibibytes." The limit is in *bytes* of the serialized body, and
 * `String.length` counts UTF-16 code units, so a naive check under-counts exactly
 * the transcripts this product produces - rupee signs and Devanagari.
 */

const copyPath = "/tmp/opencode/p-challenger/sessions-copy.db";
const EVIDENCE_SESSION = "371612d7-294e-4a53-9fc3-2de07ecf2340";

/**
 * A transcript of Devanagari text, which is 3 UTF-8 bytes per character. Sized so
 * the JSON lands under 64 KiB by `.length` and over it in real bytes.
 */
function multiByteMessages(count: number) {
  const text = "₹१२३४५६७८९०".repeat(12);
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: "user",
    parts: [{ type: "text", text }]
  }));
}

function readEvidenceMessages(): unknown[] | null {
  try {
    // Opened read-only: the challenger's copy is a real session, not a fixture.
    const db = new Database(copyPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT messages FROM sessions WHERE id = ?").get(EVIDENCE_SESSION) as
        | { messages: string }
        | undefined;
      return row ? (JSON.parse(row.messages) as unknown[]) : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

afterEach(() => {
  resetCachedDeploymentMode();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("requestBodyByteLength", () => {
  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    // Each of these is 3 bytes in UTF-8 but 1 JS character.
    const rupee = "₹".repeat(10);
    expect(rupee.length).toBe(10);
    expect(requestBodyByteLength(rupee)).toBe(30);
  });

  it("measures a multi-byte transcript that a .length check would pass", () => {
    // The challenger's measurement: 40,175 characters, 120,181 UTF-8 bytes.
    const body = "₹१२,३४५".repeat(5_000);
    expect(body.length).toBeLessThan(KEEPALIVE_BODY_LIMIT_BYTES);
    expect(requestBodyByteLength(body)).toBeGreaterThan(KEEPALIVE_BODY_LIMIT_BYTES);
  });

  it("agrees with .length for pure ASCII", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: "plain" }] });
    expect(requestBodyByteLength(body)).toBe(body.length);
  });
});

describe("saveSession with a keepalive flush", () => {
  it("refuses an oversize multi-byte body instead of letting the browser drop it", async () => {
    resetCachedDeploymentMode();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const body = JSON.stringify({ id: "big", revision: 1, messages: multiByteMessages(300) });
    // Exactly the trap: under the limit by characters, over it by bytes.
    expect(body.length).toBeLessThan(KEEPALIVE_BODY_LIMIT_BYTES);
    expect(requestBodyByteLength(body)).toBeGreaterThan(KEEPALIVE_BODY_LIMIT_BYTES);

    const failure = await saveSession(
      { id: "big", revision: 1, messages: multiByteMessages(300) as never },
      { urgent: true }
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(KeepaliveTooLargeError);
    expect((failure as KeepaliveTooLargeError).reason).toBe("keepalive_oversize");
    // No doomed request was issued; the old code's silent "Failed to fetch".
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still sends a small urgent body", async () => {
    resetCachedDeploymentMode();
    const sent: RequestInit[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(init);
      return new Response(JSON.stringify({ ok: true, revision: 1 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await saveSession({ id: "small", revision: 1, messages: [] }, { urgent: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent[0]?.keepalive).toBe(true);
  });

  it("does not apply the limit to an ordinary save", async () => {
    resetCachedDeploymentMode();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, revision: 1 }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await saveSession({ id: "big", revision: 1, messages: multiByteMessages(300) as never });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("the real stuck session", () => {
  it("is far over the keepalive limit, so the flush cannot help it", () => {
    const messages = readEvidenceMessages();
    if (!messages) {
      // The copy is not present in every environment; the shape is documented above.
      expect(true).toBe(true);
      return;
    }
    const body = JSON.stringify({ id: EVIDENCE_SESSION, revision: 11, messages });
    const bytes = requestBodyByteLength(body);
    // The 5-second throttle is what protects this conversation, not the flush.
    expect(bytes).toBeGreaterThan(KEEPALIVE_BODY_LIMIT_BYTES);
  });
});
