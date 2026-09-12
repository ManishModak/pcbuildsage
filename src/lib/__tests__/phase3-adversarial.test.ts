/**
 * src/lib/__tests__/phase3-adversarial.test.ts
 *
 * Rigorous adversarial verification and stress testing suite for Phase 3:
 * - Cross-Browser Multi-Tenant Isolation (Browser A vs Browser B, zero SQLite writes)
 * - BYOK Zero-Leakage Invariant (response headers, error sanitization, logs.db)
 * - Route Blocking in Hosted Mode & SSRF Protection (403 on sessions, scrape, profiles, logs, custom baseUrl rejection)
 * - Storage Fallback & Recovery (IndexedDB blocked -> localStorage, localStorage QuotaExceededError -> eviction and memory fallback)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist SQLite mock to memory so server databases are isolated and inspectable via SQL
vi.mock("better-sqlite3", async (importOriginal) => {
  const original = await importOriginal<typeof import("better-sqlite3")>();
  const ActualDatabase = typeof original === "function" ? original : (original as { default: typeof original }).default;
  class WrappedDatabase extends ActualDatabase {
    constructor(dbPath: string, options?: unknown) {
      super(":memory:", options as Parameters<typeof ActualDatabase>[1]);
    }
  }
  return {
    default: WrappedDatabase
  };
});

import { POST as chatRoute } from "@/app/api/chat/route";
import { GET as listSessionsRoute, POST as saveSessionsRoute } from "@/app/api/sessions/route";
import { GET as getSessionRoute, DELETE as deleteSessionRoute } from "@/app/api/sessions/[id]/route";
import { POST as scrapeRoute } from "@/app/api/scrape/route";
import { POST as profileImportRoute } from "@/app/api/profiles/import/route";
import { POST as profileTestRoute } from "@/app/api/profiles/test/route";
import { GET as logsRoute } from "@/app/api/logs/route";
import { GET as profilesRoute } from "@/app/api/profiles/route";
import { middleware } from "@/middleware";
import { NextRequest } from "next/server";

import {
  clearClientSessions,
  deleteClientSession,
  getClientSession,
  getEffectiveStorageType,
  listClientSessions,
  resetClientStoreState,
  saveClientSession,
  type SaveSessionRequest
} from "@/lib/sessions/client-store";
import type { ChatUIMessage } from "@/features/chat/message";

import {
  clearAllByokKeys,
  getByokKey,
  hasByokKey,
  injectByokHeaders,
  resetByokStoreForTesting,
  setByokKey,
  setByokStorageForTesting
} from "@/lib/llm/client-byok-store";

import {
  DEFAULT_MARKET_PREFERENCE,
  getMarketPreference,
  resetMarketStoreForTesting,
  setLocalStorageForTesting,
  setMarketPreference,
  validateMarketPreference
} from "@/lib/market/client-market-store";

import {
  isRouteBlockedInHostedMode,
  validateChatProviderUrl
} from "@/lib/config/deployment";
import { buildAppConfig, UnsafeConfigError } from "@/app/api/_lib/credentials";

import { getSessionsDb } from "@/lib/sessions";
import { closeDb, getLogsDb, writeDbLog } from "@/lib/db";
import { appendChatLog } from "@/lib/logger";
import * as chatEngine from "@/lib/llm/chat-engine";

// ============================================================================
// Test Doubles & Mock Environments
// ============================================================================

class MockStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

class MockIDBRequest {
  result: unknown = undefined;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;

  succeed(val: unknown) {
    this.result = val;
    queueMicrotask(() => this.onsuccess?.());
  }

  fail(err: Error) {
    this.error = err;
    queueMicrotask(() => this.onerror?.());
  }
}

function createMockIndexedDB(options?: {
  failOpen?: boolean;
  openError?: Error;
  failPut?: boolean;
  putError?: Error;
}) {
  const stores = new Map<string, Map<string, unknown>>();

  return {
    open() {
      const openReq = new MockIDBRequest() as unknown as IDBOpenDBRequest & MockIDBRequest;
      queueMicrotask(() => {
        if (options?.failOpen) {
          openReq.fail(options.openError ?? new DOMException("Failed to open IDB", "AbortError"));
          return;
        }

        const db = {
          objectStoreNames: {
            contains(name: string) {
              return stores.has(name);
            }
          },
          createObjectStore(name: string) {
            if (!stores.has(name)) {
              stores.set(name, new Map());
            }
            return {
              createIndex() {}
            };
          },
          transaction(storeName: string) {
            const storeMap = stores.get(storeName) ?? new Map();
            if (!stores.has(storeName)) stores.set(storeName, storeMap);

            return {
              onerror: null as (() => void) | null,
              objectStore() {
                return {
                  get(key: string) {
                    const req = new MockIDBRequest();
                    req.succeed(storeMap.get(key));
                    return req;
                  },
                  getAll() {
                    const req = new MockIDBRequest();
                    req.succeed(Array.from(storeMap.values()));
                    return req;
                  },
                  put(val: { id: string }) {
                    const req = new MockIDBRequest();
                    if (options?.failPut) {
                      req.fail(options.putError ?? new DOMException("IDB transaction put failed", "QuotaExceededError"));
                    } else {
                      storeMap.set(val.id, JSON.parse(JSON.stringify(val)));
                      req.succeed(undefined);
                    }
                    return req;
                  },
                  delete(key: string) {
                    const req = new MockIDBRequest();
                    storeMap.delete(key);
                    req.succeed(undefined);
                    return req;
                  },
                  clear() {
                    const req = new MockIDBRequest();
                    storeMap.clear();
                    req.succeed(undefined);
                    return req;
                  }
                };
              }
            };
          },
          close() {},
          onversionchange: null,
          onclose: null
        };

        openReq.result = db as unknown as IDBDatabase;
        if ((openReq as unknown as { onupgradeneeded?: () => void }).onupgradeneeded) {
          (openReq as unknown as { onupgradeneeded: () => void }).onupgradeneeded();
        }
        openReq.onsuccess?.();
      });
      return openReq;
    }
  };
}

class MockBrowserEnvironment {
  readonly name: string;
  readonly idb: ReturnType<typeof createMockIndexedDB>;
  readonly local: MockStorage;
  readonly session: MockStorage;

  constructor(name: string) {
    this.name = name;
    this.idb = createMockIndexedDB();
    this.local = new MockStorage();
    this.session = new MockStorage();
  }

  activate() {
    resetClientStoreState();
    resetByokStoreForTesting();
    resetMarketStoreForTesting();

    vi.stubGlobal("indexedDB", this.idb);
    vi.stubGlobal("localStorage", this.local);
    vi.stubGlobal("sessionStorage", this.session);

    setByokStorageForTesting(this.session, this.local);
    setLocalStorageForTesting(this.local);
  }
}

function makeMessage(id: string, text: string, role: "user" | "assistant" = "user"): ChatUIMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text }],
    createdAt: new Date()
  } as ChatUIMessage;
}

function createMockStreamResult(options?: {
  provider?: string;
  model?: string;
  fallbackIndex?: number;
  errors?: Error[];
  streamText?: string;
  triggerOnError?: Error;
}) {
  const provider = options?.provider ?? "gemini";
  const model = options?.model ?? "gemini-2.0-flash";
  const fallbackIndex = options?.fallbackIndex ?? 0;
  const errors = options?.errors;

  return {
    provider,
    model,
    fallbackIndex,
    errors,
    toUIMessageStreamResponse(opts: { messageMetadata?: () => unknown; onError?: (err: unknown) => string }) {
      if (opts.messageMetadata) {
        opts.messageMetadata();
      }
      if (options?.triggerOnError && opts.onError) {
        opts.onError(options.triggerOnError);
      }
      const text = options?.streamText ?? "Simulated assistant response text";
      return new Response(text, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
  };
}

// ============================================================================
// Test Suites
// ============================================================================

describe("Phase 3 Adversarial & Stress Testing", () => {
  const originalEnv = process.env.PCBUILDSAGE_DEPLOYMENT_MODE;

  beforeEach(() => {
    resetClientStoreState();
    resetByokStoreForTesting();
    resetMarketStoreForTesting();

    const sessionsDb = getSessionsDb();
    sessionsDb.exec("DELETE FROM sessions");
    sessionsDb.exec("DELETE FROM session_tombstones");

    const logsDb = getLogsDb();
    logsDb.exec("DELETE FROM logs");
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = originalEnv;
    } else {
      delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
    }
    resetClientStoreState();
    resetByokStoreForTesting();
    resetMarketStoreForTesting();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    closeDb();
  });

  // ==========================================================================
  // Section 1: Cross-Browser Isolation & Zero Server SQLite Writes
  // ==========================================================================
  describe("1. Cross-Browser Isolation & Zero Server SQLite Writes", () => {
    it("guarantees 100% state invisibility between Browser A and Browser B", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";

      const browserA = new MockBrowserEnvironment("Browser-A");
      const browserB = new MockBrowserEnvironment("Browser-B");

      // 1. In Browser A: save sessions, configure BYOK keys, set market preference
      browserA.activate();

      const sessionA1: SaveSessionRequest = {
        id: "sess-user-a-1",
        revision: 1,
        title: "Confidential Water-Cooled Workstation",
        countryCode: "US",
        currency: "USD",
        messages: [
          makeMessage("m1", "Need threadripper 7980X and dual RTX 4090 for confidential CAD modeling"),
          makeMessage("m2", "Here is your optimal dual-GPU build", "assistant")
        ]
      };
      const sessionA2: SaveSessionRequest = {
        id: "sess-user-a-2",
        revision: 1,
        title: "Second Session in Browser A",
        countryCode: "US",
        currency: "USD",
        messages: [makeMessage("m3", "Can I add 256GB RAM?")]
      };

      await saveClientSession(sessionA1);
      await saveClientSession(sessionA2);

      setByokKey("gemini", "AIzaSyBrowserASecretGeminiKey123", true);
      setByokKey("openrouter", "sk-or-v1-browser-a-openrouter-key-456", false);
      setMarketPreference({ countryCode: "US", currencyCode: "USD", locale: "en-US" });

      // Verify Browser A can retrieve its own state
      const aList = await listClientSessions();
      expect(aList.length).toBe(2);
      expect(await getClientSession("sess-user-a-1")).not.toBeNull();
      expect(getByokKey("gemini")).toBe("AIzaSyBrowserASecretGeminiKey123");
      expect(getByokKey("openrouter")).toBe("sk-or-v1-browser-a-openrouter-key-456");
      expect(getMarketPreference().countryCode).toBe("US");

      // 2. Switch to Browser B: Assert 100% isolation
      browserB.activate();

      const bList = await listClientSessions();
      expect(bList).toEqual([]); // Completely empty list in Browser B
      expect(await getClientSession("sess-user-a-1")).toBeNull(); // Cannot query Browser A's session
      expect(await getClientSession("sess-user-a-2")).toBeNull();

      expect(getByokKey("gemini")).toBeUndefined(); // Zero BYOK key visibility
      expect(getByokKey("openrouter")).toBeUndefined();
      expect(hasByokKey("gemini")).toBe(false);

      const injectedHeaders = injectByokHeaders({});
      expect(Object.keys(injectedHeaders).length).toBe(0); // Injected headers contain 0 keys

      // Market preference in Browser B defaults to IN/INR, not Browser A's US/USD
      expect(getMarketPreference().countryCode).toBe("IN");
      expect(getMarketPreference().currencyCode).toBe("INR");

      // 3. Browser B writes its own state
      const sessionB1: SaveSessionRequest = {
        id: "sess-user-b-budget",
        revision: 1,
        title: "Browser B Budget Gaming Rig",
        countryCode: "DE",
        currency: "EUR",
        messages: [makeMessage("mb1", "Budget 800 EUR gaming build")]
      };
      await saveClientSession(sessionB1);
      setByokKey("gemini", "AIzaSyBrowserBIsolatedKey789", false);
      setMarketPreference({ countryCode: "DE", currencyCode: "EUR", locale: "de-DE" });

      expect((await listClientSessions()).length).toBe(1);
      expect((await listClientSessions())[0].id).toBe("sess-user-b-budget");
      expect(getByokKey("gemini")).toBe("AIzaSyBrowserBIsolatedKey789");

      // 4. Switch back to Browser A: Verify Browser A remains untainted
      browserA.activate();

      const aListAgain = await listClientSessions();
      expect(aListAgain.length).toBe(2);
      expect(aListAgain.map((s) => s.id).sort()).toEqual(["sess-user-a-1", "sess-user-a-2"].sort());
      expect(await getClientSession("sess-user-b-budget")).toBeNull(); // Browser A cannot see Browser B
      expect(getByokKey("gemini")).toBe("AIzaSyBrowserASecretGeminiKey123");
      expect(getMarketPreference().countryCode).toBe("US");

      // 5. Destructive actions in Browser B do not affect Browser A
      browserB.activate();
      await deleteClientSession("sess-user-b-budget");
      await clearClientSessions();
      clearAllByokKeys();
      expect(await listClientSessions()).toEqual([]);

      browserA.activate();
      expect((await listClientSessions()).length).toBe(2);
      expect(await getClientSession("sess-user-a-1")).not.toBeNull();
      expect(getByokKey("gemini")).toBe("AIzaSyBrowserASecretGeminiKey123");
    });

    it("asserts zero server-side SQLite writes in hosted-demo mode", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";

      const browser = new MockBrowserEnvironment("Hosted-Client");
      browser.activate();

      // Perform a series of client session operations
      await saveClientSession({
        id: "sess-hosted-1",
        revision: 1,
        title: "Hosted Demo Chat",
        messages: [makeMessage("m1", "First message"), makeMessage("m2", "Second message", "assistant")]
      });
      await saveClientSession({
        id: "sess-hosted-1",
        revision: 2,
        title: "Hosted Demo Chat Updated",
        messages: [makeMessage("m1", "First message"), makeMessage("m2", "Second message", "assistant"), makeMessage("m3", "Third")]
      });
      await saveClientSession({
        id: "sess-hosted-2",
        revision: 1,
        title: "Another Session",
        messages: []
      });

      // Verify server SQLite database has exactly 0 rows
      const db = getSessionsDb();
      const sessionCount = (db.prepare("SELECT count(*) as count FROM sessions").get() as { count: number }).count;
      const tombstoneCount = (db.prepare("SELECT count(*) as count FROM session_tombstones").get() as { count: number }).count;

      expect(sessionCount).toBe(0);
      expect(tombstoneCount).toBe(0);

      // Now verify that rogue direct HTTP calls to server session endpoints are rejected with 403
      // and do not write anything to SQLite
      const roguePost = new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "rogue-sess-write",
          revision: 1,
          messages: [{ id: "rm1", role: "user", content: "Injected directly to server" }]
        })
      });
      const postRes = await saveSessionsRoute(roguePost);
      expect(postRes.status).toBe(403);

      const rogueGet = await listSessionsRoute();
      expect(rogueGet.status).toBe(403);

      const rogueGetId = await getSessionRoute(new Request("http://localhost/api/sessions/rogue-sess-write"), {
        params: Promise.resolve({ id: "rogue-sess-write" })
      });
      expect(rogueGetId.status).toBe(403);

      const rogueDelete = await deleteSessionRoute(new Request("http://localhost/api/sessions/rogue-sess-write", { method: "DELETE" }), {
        params: Promise.resolve({ id: "rogue-sess-write" })
      });
      expect(rogueDelete.status).toBe(403);

      // Server database remains absolutely clean
      const sessionCountAfter = (db.prepare("SELECT count(*) as count FROM sessions").get() as { count: number }).count;
      expect(sessionCountAfter).toBe(0);
    });
  });

  // ==========================================================================
  // Section 2: BYOK Zero-Leakage Invariant
  // ==========================================================================
  describe("2. BYOK Zero-Leakage Invariant", () => {
    beforeEach(() => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    });

    it("verifies valid BYOK key string NEVER appears in response headers or successful stream chunks", async () => {
      const geminiSecretKey = "AIzaSyTopSecretValidGeminiKey998877";
      const openRouterSecretKey = "sk-or-v1-valid-confidential-token-554433";

      vi.spyOn(chatEngine, "streamChat").mockResolvedValue(
        createMockStreamResult({
          provider: "gemini",
          model: "gemini-2.0-flash",
          streamText: "Here is your recommended Intel Core i5 14600K gaming configuration."
        }) as unknown as Awaited<ReturnType<typeof chatEngine.streamChat>>
      );

      const request = new Request("http://localhost/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gemini-api-key": geminiSecretKey,
          "x-pcbuildsage-api-key-openrouter": openRouterSecretKey
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Recommend a build" }],
          config: {
            llmChain: [{ provider: "gemini", model: "gemini-2.0-flash", keySource: "ui" }]
          }
        })
      });

      const response = await chatRoute(request);
      expect(response.status).toBe(200);

      // Inspect all response headers
      for (const [name, value] of response.headers.entries()) {
        expect(name.toLowerCase()).not.toContain("aizasy");
        expect(name.toLowerCase()).not.toContain("sk-or-v1");
        expect(value).not.toContain(geminiSecretKey);
        expect(value).not.toContain(openRouterSecretKey);
      }

      // Read response body stream
      const responseBody = await response.text();
      expect(responseBody).not.toContain(geminiSecretKey);
      expect(responseBody).not.toContain(openRouterSecretKey);
      expect(responseBody).toContain("Intel Core i5 14600K");
    });

    it("redacts raw BYOK key from upstream auth errors and server responses", async () => {
      const leakedKey = "AIzaSyUpstreamAuthFailureLeakSecret123456";

      // Simulate upstream LLM client throwing an exception echoing the raw key
      vi.spyOn(chatEngine, "streamChat").mockRejectedValue(
        new Error(`GoogleGenerativeAIError: [403 Forbidden] The API key ${leakedKey} has been revoked or expired.`)
      );

      const request = new Request("http://localhost/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gemini-api-key": leakedKey
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Build PC" }],
          config: {
            llmChain: [{ provider: "gemini", model: "gemini-2.0-flash", keySource: "ui" }]
          }
        })
      });

      const response = await chatRoute(request);
      expect(response.status).toBe(500);

      // Verify no response headers contain the leaked key
      for (const [, value] of response.headers.entries()) {
        expect(value).not.toContain(leakedKey);
      }

      // Verify response body has redacted the key
      const responseText = await response.text();
      expect(responseText).not.toContain(leakedKey);
      expect(responseText).toContain("[REDACTED]");
    });

    it("redacts raw key from stream error frames during mid-stream disconnection", async () => {
      const midStreamKey = "sk-or-v1-stream-failure-secret-key-999";

      vi.spyOn(chatEngine, "streamChat").mockResolvedValue(
        createMockStreamResult({
          provider: "openrouter",
          model: "anthropic/claude-3.5-sonnet",
          triggerOnError: new Error(`Stream network drop occurred for token ${midStreamKey}`)
        }) as unknown as Awaited<ReturnType<typeof chatEngine.streamChat>>
      );

      const request = new Request("http://localhost/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openrouter-api-key": midStreamKey
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Generate parts list" }],
          config: {
            llmChain: [{ provider: "openrouter", model: "anthropic/claude-3.5-sonnet", keySource: "ui" }]
          }
        })
      });

      const response = await chatRoute(request);
      const text = await response.text();

      // Raw key must never be transmitted in stream
      expect(text).not.toContain(midStreamKey);
    });

    it("redacts sensitive keys passed inside URLs and query strings in error messages", async () => {
      const urlKey = "AIzaSySecretEmbeddedInGoogleApiUrl1234567";

      vi.spyOn(chatEngine, "streamChat").mockRejectedValue(
        new Error(`FetchError: GET https://generativelanguage.googleapis.com/v1beta/models?key=${urlKey} failed with code 503`)
      );

      const request = new Request("http://localhost/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gemini-api-key": urlKey
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Query models" }],
          config: {
            llmChain: [{ provider: "gemini", model: "gemini-2.0-flash", keySource: "ui" }]
          }
        })
      });

      const response = await chatRoute(request);
      const text = await response.text();
      expect(text).not.toContain(urlKey);
      expect(text).toContain("key=[REDACTED]");
    });

    it("guarantees zero BYOK secret leakage in SQLite server log database (logs.db)", async () => {
      const secretToProtect = "AIzaSySuperSecretDatabaseAuditKey999";
      const secretToken = "sk-or-v1-database-audit-token-888";
      const customKey = "secret-arbitrary-key-777";

      // 1. Attempt writing log entries with secrets in details
      writeDbLog(undefined, "INFO", "chat", "Processing user prompt", {
        apiKey: secretToProtect,
        token: secretToken,
        "x-api-key": customKey,
        session_id: "test-sess",
        safeNote: "This note is safe"
      });

      // 2. Also test appendChatLog with metadata
      await appendChatLog({
        session_id: "test-sess",
        role: "user",
        content: "Build request with user content"
      });

      // 3. Direct SQL inspection of logs.db table
      const logsDb = getLogsDb();
      const allLogs = logsDb.prepare("SELECT id, message, details FROM logs").all() as Array<{
        id: number;
        message: string;
        details: string | null;
      }>;

      expect(allLogs.length).toBeGreaterThan(0);

      for (const row of allLogs) {
        // Assert raw secret strings never appear anywhere in message or details
        expect(row.message).not.toContain(secretToProtect);
        expect(row.message).not.toContain(secretToken);
        expect(row.message).not.toContain(customKey);

        if (row.details) {
          expect(row.details).not.toContain(secretToProtect);
          expect(row.details).not.toContain(secretToken);
          expect(row.details).not.toContain(customKey);
        }

        if (row.details && row.message === "Processing user prompt") {
          expect(row.details).toContain("[redacted]");
        }
      }

      // Direct SQL queries searching for the secret strings return exactly 0 rows
      const countLeaked = (
        logsDb
          .prepare(
            `SELECT count(*) as count FROM logs WHERE message LIKE ? OR details LIKE ? OR message LIKE ? OR details LIKE ?`
          )
          .get(`%${secretToProtect}%`, `%${secretToProtect}%`, `%${secretToken}%`, `%${secretToken}%`) as { count: number }
      ).count;

      expect(countLeaked).toBe(0);
    });

    it("strictly blocks GET /api/logs in hosted-demo mode, preventing administrative log enumeration", async () => {
      const request = new Request("http://localhost/api/logs", { method: "GET" });
      const response = await logsRoute(request);
      expect(response.status).toBe(403);
      const data = (await response.json()) as { code: string };
      expect(data.code).toBe("HOSTED_DEMO_FORBIDDEN");
    });
  });

  // ==========================================================================
  // Section 3: Route Blocking in Hosted Mode & SSRF Protection
  // ==========================================================================
  describe("3. Route Blocking in Hosted Mode & SSRF Protection", () => {
    beforeEach(() => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    });

    it("verifies HTTP 403 on all blocked routes in hosted-demo mode", async () => {
      // 1. GET & POST /api/sessions
      expect((await listSessionsRoute()).status).toBe(403);
      expect(
        (
          await saveSessionsRoute(
            new Request("http://localhost/api/sessions", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id: "s1", revision: 1, messages: [] })
            })
          )
        ).status
      ).toBe(403);

      // 2. GET & DELETE /api/sessions/[id]
      expect(
        (
          await getSessionRoute(new Request("http://localhost/api/sessions/s1"), {
            params: Promise.resolve({ id: "s1" })
          })
        ).status
      ).toBe(403);
      expect(
        (
          await deleteSessionRoute(new Request("http://localhost/api/sessions/s1", { method: "DELETE" }), {
            params: Promise.resolve({ id: "s1" })
          })
        ).status
      ).toBe(403);

      // 3. POST /api/scrape
      expect(
        (
          await scrapeRoute(
            new Request("http://localhost/api/scrape", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ profile: "india" })
            })
          )
        ).status
      ).toBe(403);

      // 4. POST /api/profiles/import
      expect(
        (
          await profileImportRoute(
            new Request("http://localhost/api/profiles/import", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ profile: {} })
            })
          )
        ).status
      ).toBe(403);

      // 5. POST /api/profiles/test
      expect(
        (
          await profileTestRoute(
            new Request("http://localhost/api/profiles/test", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ profile: "india" })
            })
          )
        ).status
      ).toBe(403);

      // 6. GET /api/logs
      expect((await logsRoute(new Request("http://localhost/api/logs"))).status).toBe(403);

      // 7. GET /api/profiles
      expect((await profilesRoute(new Request("http://localhost/api/profiles"))).status).toBe(403);
    });

    it("verifies Next.js Edge Middleware enforcement across blocked endpoints and HTTP verbs", () => {
      const blockedPaths = [
        "/api/scrape",
        "/api/profiles/import",
        "/api/profiles/test",
        "/api/profiles",
        "/api/logs"
      ];
      const methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"];

      for (const path of blockedPaths) {
        for (const method of methods) {
          const req = new NextRequest(`http://localhost${path}`, { method });
          const res = middleware(req);
          expect(res.status).toBe(403);
        }
      }
    });

    it("thwarts adversarial path evasion attempts (URL encoding, traversal, duplicate slashes)", () => {
      const adversarialPaths = [
        "//api//scrape",
        "///api///scrape",
        "/api/scrape/",
        "/api/scrape//",
        "/api/%73crape", // 's' encoded
        "/api/%73%63%72%61%70%65", // 'scrape' fully encoded
        "/api/sessions/../scrape", // path traversal
        "/api/profiles/../scrape",
        "/api/../api/scrape",
        "/api/logs?format=json&admin=true", // query param smuggling
        "/api/scrape#payload",
        "/API/SCRAPE", // uppercase
        "/Api/Logs"
      ];

      for (const path of adversarialPaths) {
        const blocked = isRouteBlockedInHostedMode(path, "POST", "hosted-demo");
        expect(blocked).toBe(true);
      }
    });

    it("strictly rejects arbitrary custom baseUrls in chat config (SSRF protection)", () => {
      const maliciousBaseUrls = [
        "http://169.254.169.254/latest/meta-data", // AWS / GCP / Azure IMDS
        "http://169.254.169.254:80",
        "http://127.0.0.1:8000", // local loopbacks
        "http://127.0.0.1:11434",
        "http://localhost:11434",
        "http://[::1]:8080",
        "https://10.0.0.1/v1", // RFC 1918 private subnets
        "https://172.16.0.1/v1",
        "https://192.168.1.1/v1",
        "https://evil-attacker-llm-proxy.com/v1", // arbitrary external domain
        "http://generativelanguage.googleapis.com", // unencrypted HTTP
        "https://user:password@openrouter.ai/api/v1", // embedded credentials
        "https://generativelanguage.googleapis.com:8443", // non-standard port
        "https://openrouter.ai.attacker.org/v1" // subdomain spoofing
      ];

      for (const url of maliciousBaseUrls) {
        const check = validateChatProviderUrl(url, "hosted-demo");
        expect(check.allowed).toBe(false);

        // Assert buildAppConfig throws UnsafeConfigError
        expect(() =>
          buildAppConfig(new Headers(), {
            llmChain: [{ provider: "openai-compatible", model: "gpt-4o", baseUrl: url }]
          })
        ).toThrow(UnsafeConfigError);
      }
    });

    it("rejects POST /api/chat with 400 Bad Request when malicious baseUrl is supplied in hosted-demo mode", async () => {
      const request = new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "probe" }],
          config: {
            llmChain: [
              {
                provider: "openai-compatible",
                model: "gpt-4o",
                baseUrl: "http://169.254.169.254/latest/meta-data"
              }
            ]
          }
        })
      });

      const response = await chatRoute(request);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("invalid_request");
      expect(text).not.toContain("169.254.169.254"); // Zero reflection of sensitive target
    });

    it("rejects provider 'ollama' and search provider 'searxng' outright in hosted-demo mode", () => {
      // Ollama rejection
      expect(() =>
        buildAppConfig(new Headers(), {
          llmChain: [{ provider: "ollama", model: "llama3" }]
        })
      ).toThrow(UnsafeConfigError);

      // SearxNG rejection
      expect(() =>
        buildAppConfig(new Headers(), {
          searchProvider: "searxng",
          searchBaseUrl: "http://127.0.0.1:8888"
        })
      ).toThrow(UnsafeConfigError);
    });

    it("permits standard public endpoints and local operations when switched to local mode", async () => {
      process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "local";

      expect(isRouteBlockedInHostedMode("/api/scrape", "POST", "local")).toBe(false);
      expect(isRouteBlockedInHostedMode("/api/logs", "GET", "local")).toBe(false);
      expect(isRouteBlockedInHostedMode("/api/profiles", "GET", "local")).toBe(false);

      // Local custom baseUrl is permitted (e.g. self-hosted llama-server or ollama)
      const localCheck = validateChatProviderUrl("http://127.0.0.1:8080/v1", "local");
      expect(localCheck.allowed).toBe(true);

      // Server sessions route works in local mode
      const listRes = await listSessionsRoute();
      expect(listRes.status).toBe(200);
    });
  });

  // ==========================================================================
  // Section 4: Storage Fallback & Recovery
  // ==========================================================================
  describe("4. Storage Fallback & Recovery", () => {
    it("recovers and falls back to localStorage when IndexedDB is unavailable (undefined)", async () => {
      vi.stubGlobal("indexedDB", undefined);
      const mockLs = new MockStorage();
      vi.stubGlobal("localStorage", mockLs);

      expect(await getEffectiveStorageType()).toBe("localstorage");

      const session: SaveSessionRequest = {
        id: "sess-ls-fallback-1",
        revision: 1,
        title: "LocalStorage Fallback Build",
        countryCode: "IN",
        currency: "INR",
        messages: [makeMessage("m1", "Need Ryzen 5 7600 gaming build")]
      };

      await saveClientSession(session);

      // Verify stored in localStorage with prefix
      expect(mockLs.getItem("pcbuildsage:session:sess-ls-fallback-1")).not.toBeNull();

      const retrieved = await getClientSession("sess-ls-fallback-1");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe("sess-ls-fallback-1");
      expect(retrieved?.title).toBe("LocalStorage Fallback Build");
      expect(retrieved?.country_code).toBe("IN");
      expect(retrieved?.currency).toBe("INR");

      const list = await listClientSessions();
      expect(list.length).toBe(1);
      expect(list[0].id).toBe("sess-ls-fallback-1");

      await deleteClientSession("sess-ls-fallback-1");
      expect(await getClientSession("sess-ls-fallback-1")).toBeNull();
      expect(await listClientSessions()).toEqual([]);
    });

    it("recovers and falls back to localStorage when IndexedDB.open throws a SecurityError", async () => {
      vi.stubGlobal("indexedDB", {
        open() {
          throw new DOMException("Access denied in sandboxed third-party iframe", "SecurityError");
        }
      });
      const mockLs = new MockStorage();
      vi.stubGlobal("localStorage", mockLs);

      expect(await getEffectiveStorageType()).toBe("localstorage");

      await saveClientSession({
        id: "sess-security-err",
        revision: 1,
        title: "Session in Sandboxed Iframe",
        messages: [makeMessage("m1", "Iframe test")]
      });

      const retrieved = await getClientSession("sess-security-err");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.title).toBe("Session in Sandboxed Iframe");
    });

    it("recovers and falls back to localStorage when IndexedDB.open request fires onerror", async () => {
      const mockIdb = createMockIndexedDB({
        failOpen: true,
        openError: new DOMException("IDB database locked by another process", "InvalidStateError")
      });
      vi.stubGlobal("indexedDB", mockIdb);
      const mockLs = new MockStorage();
      vi.stubGlobal("localStorage", mockLs);

      expect(await getEffectiveStorageType()).toBe("localstorage");

      await saveClientSession({
        id: "sess-idb-open-fail",
        revision: 1,
        title: "IDB Open Failure Fallback",
        messages: []
      });

      const retrieved = await getClientSession("sess-idb-open-fail");
      expect(retrieved?.title).toBe("IDB Open Failure Fallback");
    });

    it("recovers and falls back to localStorage when IndexedDB put operation fails mid-transaction", async () => {
      const mockIdb = createMockIndexedDB({
        failPut: true,
        putError: new DOMException("Transaction aborted due to disk failure", "AbortError")
      });
      vi.stubGlobal("indexedDB", mockIdb);
      const mockLs = new MockStorage();
      vi.stubGlobal("localStorage", mockLs);

      // getEffectiveStorageType initially reports indexeddb
      expect(await getEffectiveStorageType()).toBe("indexeddb");

      // Save session should catch the transaction failure and fall back to lsSave
      await saveClientSession({
        id: "sess-mid-tx-fail",
        revision: 1,
        title: "Mid-Flight IDB Error Recovery",
        messages: [makeMessage("m1", "Payload surviving transaction error")]
      });

      // Verify successfully persisted in localStorage
      expect(mockLs.getItem("pcbuildsage:session:sess-mid-tx-fail")).not.toBeNull();

      const retrieved = await getClientSession("sess-mid-tx-fail");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.title).toBe("Mid-Flight IDB Error Recovery");
    });

    it("falls back to in-memory store when both IndexedDB and localStorage are blocked", async () => {
      vi.stubGlobal("indexedDB", undefined);
      vi.stubGlobal("localStorage", undefined);

      expect(await getEffectiveStorageType()).toBe("memory");

      await saveClientSession({
        id: "sess-pure-mem-1",
        revision: 1,
        title: "Pure In-Memory Session",
        messages: [makeMessage("m1", "Ephemeral only")]
      });

      const retrieved = await getClientSession("sess-pure-mem-1");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.title).toBe("Pure In-Memory Session");

      const list = await listClientSessions();
      expect(list.length).toBe(1);
      expect(list[0].id).toBe("sess-pure-mem-1");

      await deleteClientSession("sess-pure-mem-1");
      expect(await getClientSession("sess-pure-mem-1")).toBeNull();
      expect(await listClientSessions()).toEqual([]);
    });

    it("handles localStorage QuotaExceededError by pruning oldest session or falling back to memory", async () => {
      vi.stubGlobal("indexedDB", undefined);
      const mockLs = new MockStorage();

      let quotaTripped = false;
      const originalSetItem = mockLs.setItem.bind(mockLs);

      mockLs.setItem = (key: string, value: string) => {
        if (quotaTripped) {
          throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        }
        originalSetItem(key, value);
      };
      vi.stubGlobal("localStorage", mockLs);

      // Save first healthy session
      await saveClientSession({
        id: "sess-old",
        revision: 1,
        title: "Old Session",
        messages: [makeMessage("m1", "First")]
      });
      expect(await getClientSession("sess-old")).not.toBeNull();

      // Trip the quota error
      quotaTripped = true;

      // Saving another session should NOT throw an unhandled error to the caller
      await expect(
        saveClientSession({
          id: "sess-new-during-quota",
          revision: 1,
          title: "Session Saved During Quota Error",
          messages: [makeMessage("m2", "New")]
        })
      ).resolves.toBeUndefined();

      // The new session is safely accessible via memory fallback
      const retrievedNew = await getClientSession("sess-new-during-quota");
      expect(retrievedNew).not.toBeNull();
      expect(retrievedNew?.id).toBe("sess-new-during-quota");
      expect(retrievedNew?.title).toBe("Session Saved During Quota Error");

      // Both the existing local session and in-memory session are listed
      const combinedList = await listClientSessions();
      expect(combinedList.some((s) => s.id === "sess-new-during-quota")).toBe(true);
    });

    it("resiliently handles corrupted or malformed entries in storage without crashing", async () => {
      vi.stubGlobal("indexedDB", undefined);
      const mockLs = new MockStorage();
      vi.stubGlobal("localStorage", mockLs);

      // Save a valid session
      await saveClientSession({
        id: "sess-valid-1",
        revision: 1,
        title: "Valid Session",
        messages: []
      });

      // Inject malformed JSON and corrupted payloads into localStorage
      mockLs.setItem("pcbuildsage:session:corrupt-1", "{invalid-json-syntax");
      mockLs.setItem("pcbuildsage:session:corrupt-2", JSON.stringify({ notAnId: 123 }));
      mockLs.setItem("pcbuildsage:session:corrupt-3", "null");

      // Listing must not throw and returns valid sessions
      const list = await listClientSessions();
      expect(list.length).toBe(1);
      expect(list[0].id).toBe("sess-valid-1");

      // Getting a corrupted session returns null instead of throwing
      expect(await getClientSession("corrupt-1")).toBeNull();
      expect(await getClientSession("corrupt-2")).toBeNull();
      expect(await getClientSession("non-existent-session")).toBeNull();
    });

    it("validates and sanitizes market preference input against adversarial injection", () => {
      // 1. Normal valid input
      const pref = validateMarketPreference({ countryCode: "ca", currencyCode: "cad", locale: "en-CA" });
      expect(pref).toEqual({ countryCode: "CA", currencyCode: "CAD", locale: "en-CA" });

      // 2. Adversarial inputs: SQLi, XSS, non-standard lengths
      const sqlInjection = validateMarketPreference({
        countryCode: "US'; DROP TABLE sessions;--",
        currencyCode: "<script>alert('xss')</script>",
        locale: 12345
      });
      // Falls back to safe default
      expect(sqlInjection.countryCode).toBe(DEFAULT_MARKET_PREFERENCE.countryCode);
      expect(sqlInjection.currencyCode).toBe(DEFAULT_MARKET_PREFERENCE.currencyCode);
      expect(sqlInjection.locale).toBe(DEFAULT_MARKET_PREFERENCE.locale);

      // 3. Invalid types or null
      expect(validateMarketPreference(null)).toEqual(DEFAULT_MARKET_PREFERENCE);
      expect(validateMarketPreference("random-string")).toEqual(DEFAULT_MARKET_PREFERENCE);
      expect(validateMarketPreference({})).toEqual(DEFAULT_MARKET_PREFERENCE);

      // 4. setMarketPreference throws on explicit invalid country / currency codes
      expect(() => setMarketPreference({ countryCode: "USA" })).toThrow("Invalid countryCode");
      expect(() => setMarketPreference({ currencyCode: "US" })).toThrow("Invalid currencyCode");
    });
  });
});
