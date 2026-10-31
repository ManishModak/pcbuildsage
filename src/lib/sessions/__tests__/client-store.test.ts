import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearClientSessions,
  deleteClientSession,
  getClientSession,
  getEffectiveStorageType,
  listClientSessions,
  resetClientStoreState,
  saveClientSession,
  SessionConflictError,
  SessionPersistenceError,
  _setStorageDriverForTesting,
  type SaveSessionRequest
} from "../client-store";
import type { ChatUIMessage } from "@/features/chat/message";

class MockIDBRequest {
  result: unknown = undefined;
  error: unknown = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;

  succeed(val: unknown) {
    this.result = val;
    queueMicrotask(() => this.onsuccess?.());
  }

  fail(err: unknown) {
    this.error = err;
    queueMicrotask(() => this.onerror?.());
  }
}

function createMockIndexedDB(options?: { rollBackWrites?: boolean; log?: string[] }) {
  const stores = new Map<string, Map<string, unknown>>();
  let transactionSeq = 0;

  return {
    open() {
      const openReq = new MockIDBRequest() as unknown as IDBOpenDBRequest & MockIDBRequest;
      queueMicrotask(() => {
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
          transaction(storeName: string | string[]) {
            // Real IndexedDB accepts one store or a scope list; the checked
            // save opens its revision-check transaction over both the session
            // and tombstone stores.
            const names = Array.isArray(storeName) ? storeName : [storeName];
            const maps = new Map<string, Map<string, unknown>>();
            for (const name of names) {
              let storeMap = stores.get(name);
              if (!storeMap) {
                storeMap = new Map();
                stores.set(name, storeMap);
              }
              maps.set(name, storeMap);
            }
            const txId = (transactionSeq += 1);
            options?.log?.push(`tx#${txId}:open:${names.join("+")}`);

            // Real IndexedDB settles a write on the *transaction*: the request's
            // `success` fires first, then the transaction commits (`oncomplete`).
            // A request error bubbles up to the transaction, which aborts it.
            const tx: {
              oncomplete: (() => void) | null;
              onabort: (() => void) | null;
              onerror: (() => void) | null;
              objectStore: () => unknown;
            } = { oncomplete: null, onabort: null, onerror: null, objectStore: () => undefined };

            const commit = (apply: () => void) => {
              queueMicrotask(() => {
                apply();
                if (options?.rollBackWrites) tx.onabort?.();
                else tx.oncomplete?.();
              });
            };

            tx.objectStore = (name?: string) => {
              const storeMap = (name ? maps.get(name) : undefined) ?? maps.get(names[0]) ?? new Map();
              const storeName = name ?? names[0];
              return {
              get(key: string) {
                const req = new MockIDBRequest();
                options?.log?.push(`tx#${txId}:get:${storeName}`);
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
                options?.log?.push(`tx#${txId}:put:${storeName}`);
                commit(() => {
                  if (options?.rollBackWrites) return;
                  storeMap.set(val.id, JSON.parse(JSON.stringify(val)));
                  req.succeed(undefined);
                });
                return req;
              },
              delete(key: string) {
                const req = new MockIDBRequest();
                commit(() => {
                  if (options?.rollBackWrites) return;
                  storeMap.delete(key);
                  req.succeed(undefined);
                });
                return req;
              },
              clear() {
                const req = new MockIDBRequest();
                commit(() => {
                  if (options?.rollBackWrites) return;
                  storeMap.clear();
                  req.succeed(undefined);
                });
                return req;
              }
              };
            };

            return tx;
          },
          close() {},
          onversionchange: null,
          onclose: null
        };

        openReq.result = db as unknown as IDBDatabase;
        if (openReq.onupgradeneeded) {
          (openReq as unknown as { onupgradeneeded: () => void }).onupgradeneeded();
        }
        openReq.onsuccess?.();
      });
      return openReq;
    },
    /**
     * Rows that actually committed, for asserting what reached storage - and
     * for seeding rows directly. The map is created on first access, so a
     * `.set` before any transaction opened the store still lands in the map
     * the store later reads (previously this returned a detached map and the
     * seed was silently discarded, which made layer-merge tests vacuous).
     */
    _rows(storeName = "chat_sessions") {
      let rows = stores.get(storeName);
      if (!rows) {
        rows = new Map<string, unknown>();
        stores.set(storeName, rows);
      }
      return rows;
    }
  };
}

function createMockLocalStorage() {
  const map = new Map<string, string>();
  return {
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
    removeItem(key: string) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    get length() {
      return map.size;
    }
  };
}

function makeMessage(id: string, text: string): ChatUIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }]
  } as ChatUIMessage;
}

describe("ClientStore", () => {
  beforeEach(() => {
    resetClientStoreState();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    resetClientStoreState();
    vi.unstubAllGlobals();
  });

  describe("IndexedDB (Primary Driver)", () => {
    it("uses IndexedDB when available to save, retrieve, list, delete, and clear", async () => {
      const mockIdb = createMockIndexedDB();
      vi.stubGlobal("indexedDB", mockIdb);

      expect(await getEffectiveStorageType()).toBe("indexeddb");

      const req: SaveSessionRequest = {
        id: "sess-idb-1",
        revision: 1,
        title: "IDB Gaming Build",
        countryCode: "US",
        currency: "USD",
        messages: [makeMessage("m1", "Need RTX 4080")]
      };

      await saveClientSession(req);

      const retrieved = await getClientSession("sess-idb-1");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe("sess-idb-1");
      expect(retrieved?.title).toBe("IDB Gaming Build");
      expect(retrieved?.revision).toBe(1);
      expect(retrieved?.country_code).toBe("US");
      expect(retrieved?.currency).toBe("USD");
      expect(retrieved?.messages.length).toBe(1);
      expect(retrieved?.messages[0].id).toBe("m1");
      expect(retrieved?.created_at).toBeInstanceOf(Date);
      expect(retrieved?.updated_at).toBeInstanceOf(Date);

      const list = await listClientSessions();
      expect(list.length).toBe(1);
      expect(list[0].id).toBe("sess-idb-1");
      expect(list[0].title).toBe("IDB Gaming Build");
      expect(list[0].created_at).toBeInstanceOf(Date);
      expect(list[0].updated_at).toBeInstanceOf(Date);

      await deleteClientSession("sess-idb-1");
      expect(await getClientSession("sess-idb-1")).toBeNull();
      expect(await listClientSessions()).toEqual([]);

      // Test clear
      await saveClientSession({ id: "s1", revision: 1, messages: [] });
      await saveClientSession({ id: "s2", revision: 1, messages: [] });
      expect((await listClientSessions()).length).toBe(2);
      await clearClientSessions();
      expect(await listClientSessions()).toEqual([]);
    });

    it("rejects a write whose transaction aborts, instead of reporting the request's success", async () => {
      vi.stubGlobal("indexedDB", createMockIndexedDB({ rollBackWrites: true }));
      const mockLs = createMockLocalStorage();
      vi.stubGlobal("localStorage", mockLs);

      expect(await getEffectiveStorageType()).toBe("indexeddb");

      // The put's `onsuccess` fires and *then* the transaction aborts. Resolving
      // on the request (the old behaviour) would report a save that was rolled back.
      await saveClientSession({
        id: "rolled-back",
        revision: 1,
        title: "Never Committed",
        messages: [makeMessage("m1", "gone")]
      });

      // Nothing reached IndexedDB; the write fell through to localStorage instead.
      expect(mockLs.getItem("pcbuildsage:session:rolled-back")).not.toBeNull();
    });
  });

  describe("LocalStorage Fallback", () => {
    it("falls back to localStorage when IndexedDB is unavailable", async () => {
      vi.stubGlobal("indexedDB", undefined);
      const mockLs = createMockLocalStorage();
      vi.stubGlobal("localStorage", mockLs);

      expect(await getEffectiveStorageType()).toBe("localstorage");

      const req: SaveSessionRequest = {
        id: "sess-ls-1",
        revision: 2,
        title: "LS Build",
        messages: [makeMessage("m1", "Hello localStorage")]
      };

      await saveClientSession(req);

      // Verify it was stored with the pcbuildsage prefix
      expect(mockLs.getItem("pcbuildsage:session:sess-ls-1")).not.toBeNull();

      const retrieved = await getClientSession("sess-ls-1");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe("sess-ls-1");
      expect(retrieved?.title).toBe("LS Build");
      expect(retrieved?.revision).toBe(2);
      expect(retrieved?.messages.length).toBe(1);

      const list = await listClientSessions();
      expect(list.length).toBe(1);
      expect(list[0].id).toBe("sess-ls-1");

      await deleteClientSession("sess-ls-1");
      expect(mockLs.getItem("pcbuildsage:session:sess-ls-1")).toBeNull();
      expect(await getClientSession("sess-ls-1")).toBeNull();
    });

    it("falls back to localStorage when IndexedDB.open throws a SecurityError", async () => {
      vi.stubGlobal("indexedDB", {
        open() {
          throw new DOMException("Access denied in sandboxed iframe", "SecurityError");
        }
      });
      const mockLs = createMockLocalStorage();
      vi.stubGlobal("localStorage", mockLs);

      expect(await getEffectiveStorageType()).toBe("localstorage");

      await saveClientSession({
        id: "secure-sess",
        revision: 1,
        title: "Private Window Session",
        messages: []
      });

      const got = await getClientSession("secure-sess");
      expect(got?.title).toBe("Private Window Session");
    });
  });

  describe("No durable storage (memory-only)", () => {
    it("reports the save as failed when both IndexedDB and localStorage are unavailable", async () => {
      vi.stubGlobal("indexedDB", undefined);
      vi.stubGlobal("localStorage", undefined);

      expect(await getEffectiveStorageType()).toBe("memory");

      // An in-memory copy is gone the moment the tab closes, so reporting success
      // here would be a lie. The throw is what makes the queue retry and the UI warn.
      await expect(
        saveClientSession({
          id: "mem-sess-1",
          revision: 1,
          title: "In-Memory Session",
          messages: [makeMessage("m1", "Ephemeral message")]
        })
      ).rejects.toBeInstanceOf(SessionPersistenceError);

      expect(await getClientSession("mem-sess-1")).toBeNull();
      expect(await listClientSessions()).toEqual([]);
    });

    it("carries a machine-readable reason and the underlying cause", async () => {
      vi.stubGlobal("indexedDB", undefined);
      vi.stubGlobal("localStorage", {
        setItem() {
          throw new DOMException("Storage disabled", "SecurityError");
        },
        getItem() {
          throw new DOMException("Storage disabled", "SecurityError");
        },
        removeItem() {},
        clear() {},
        key() { return null; },
        length: 0
      });

      expect(await getEffectiveStorageType()).toBe("memory");

      const failure = await saveClientSession({
        id: "mem-sess-2",
        revision: 1,
        title: "Fallback on security error",
        messages: []
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(SessionPersistenceError);
      expect((failure as SessionPersistenceError).reason).toBe("no_durable_storage");
      expect(await getClientSession("mem-sess-2")).toBeNull();
    });
  });

  describe("Sorting", () => {
    it("orders sessions newest-first by updated_at", async () => {
      vi.stubGlobal("indexedDB", undefined);
      vi.stubGlobal("localStorage", createMockLocalStorage());
      _setStorageDriverForTesting("localstorage");

      vi.useFakeTimers();

      vi.setSystemTime(new Date("2026-09-01T10:00:00Z"));
      await saveClientSession({ id: "s1", revision: 1, title: "Oldest", messages: [] });

      vi.setSystemTime(new Date("2026-09-03T12:00:00Z"));
      await saveClientSession({ id: "s2", revision: 1, title: "Newest", messages: [] });

      vi.setSystemTime(new Date("2026-09-02T11:00:00Z"));
      await saveClientSession({ id: "s3", revision: 1, title: "Middle", messages: [] });

      const list = await listClientSessions();
      expect(list.map((s) => s.id)).toEqual(["s2", "s3", "s1"]);
      expect(list[0].title).toBe("Newest");
      expect(list[1].title).toBe("Middle");
      expect(list[2].title).toBe("Oldest");

      vi.useRealTimers();
    });

    it("moves updated sessions to top of list", async () => {
      vi.stubGlobal("indexedDB", undefined);
      vi.stubGlobal("localStorage", createMockLocalStorage());
      _setStorageDriverForTesting("localstorage");

      vi.useFakeTimers();

      vi.setSystemTime(new Date("2026-09-01T10:00:00Z"));
      await saveClientSession({ id: "s1", revision: 1, title: "Session 1", messages: [] });

      vi.setSystemTime(new Date("2026-09-02T10:00:00Z"));
      await saveClientSession({ id: "s2", revision: 1, title: "Session 2", messages: [] });

      expect((await listClientSessions()).map((s) => s.id)).toEqual(["s2", "s1"]);

      // Update s1 at later timestamp
      vi.setSystemTime(new Date("2026-09-03T10:00:00Z"));
      await saveClientSession({ id: "s1", revision: 2, title: "Session 1 Updated", messages: [] });

      expect((await listClientSessions()).map((s) => s.id)).toEqual(["s1", "s2"]);

      vi.useRealTimers();
    });
  });

  describe("Corrupted Data Resilience", () => {
    it("gracefully ignores corrupted JSON in localStorage during listClientSessions", async () => {
      vi.stubGlobal("indexedDB", undefined);
      const mockLs = createMockLocalStorage();
      vi.stubGlobal("localStorage", mockLs);

      // Save a healthy session
      await saveClientSession({ id: "healthy-1", revision: 1, title: "Good 1", messages: [] });
      await saveClientSession({ id: "healthy-2", revision: 1, title: "Good 2", messages: [] });

      // Inject corrupted JSON
      mockLs.setItem("pcbuildsage:session:corrupt-json", "{not-valid-json:::;;;");
      mockLs.setItem("pcbuildsage:session:corrupt-data", JSON.stringify({ invalid: true, missing_id: 123 }));

      const list = await listClientSessions();
      expect(list.length).toBe(2);
      expect(list.map((s) => s.id).sort()).toEqual(["healthy-1", "healthy-2"]);
    });

    it("returns null when getClientSession encounters corrupted JSON", async () => {
      vi.stubGlobal("indexedDB", undefined);
      const mockLs = createMockLocalStorage();
      vi.stubGlobal("localStorage", mockLs);

      mockLs.setItem("pcbuildsage:session:corrupted-single", "not-json-content");

      const result = await getClientSession("corrupted-single");
      expect(result).toBeNull();
    });

    it("returns null for non-existent session ID", async () => {
      _setStorageDriverForTesting("memory");
      expect(await getClientSession("non-existent-id")).toBeNull();
    });
  });

  describe("Quota Handling Resilience", () => {
    it("reports a full store instead of deleting an older chat to make room", async () => {
      vi.stubGlobal("indexedDB", undefined);
      const mockLs = createMockLocalStorage();

      // Configure mock localStorage to throw QuotaExceededError after a certain count
      let quotaActive = false;
      const originalSetItem = mockLs.setItem.bind(mockLs);
      mockLs.setItem = (key: string, val: string) => {
        if (quotaActive) {
          const err = new DOMException("The quota has been exceeded.", "QuotaExceededError");
          throw err;
        }
        originalSetItem(key, val);
      };
      vi.stubGlobal("localStorage", mockLs);

      await saveClientSession({ id: "s1", revision: 1, title: "First Session", messages: [] });
      expect(await getClientSession("s1")).not.toBeNull();

      // Now activate quota error
      quotaActive = true;

      const failure = await saveClientSession({
        id: "s-large",
        revision: 1,
        title: "Large Session",
        messages: []
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(SessionPersistenceError);
      expect((failure as SessionPersistenceError).reason).toBe("quota_exceeded");
      expect((failure as SessionPersistenceError).cause).toBeInstanceOf(DOMException);

      // The older chat is untouched: only the user decides what to delete.
      expect(mockLs.getItem("pcbuildsage:session:s1")).not.toBeNull();
      const older = await getClientSession("s1");
      expect(older?.title).toBe("First Session");
    });
  });

  describe("Layer drift", () => {
    it("opens the newest copy, matching what the sidebar lists", async () => {
      const mockIdb = createMockIndexedDB();
      vi.stubGlobal("indexedDB", mockIdb);
      const mockLs = createMockLocalStorage();
      vi.stubGlobal("localStorage", mockLs);

      // A stale copy in IndexedDB and a newer one in localStorage, which is what a
      // failed IndexedDB write followed by a localStorage fallback leaves behind.
      mockIdb._rows().set("drift", {
        id: "drift",
        revision: 1,
        title: "Stale copy",
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z",
        country_code: "IN",
        currency: "INR",
        messages: [makeMessage("m1", "stale")],
        build_state: null
      });
      mockLs.setItem(
        "pcbuildsage:session:drift",
        JSON.stringify({
          id: "drift",
          revision: 2,
          title: "Newest copy",
          created_at: "2026-09-01T00:00:00.000Z",
          updated_at: "2026-09-02T00:00:00.000Z",
          country_code: "IN",
          currency: "INR",
          messages: [makeMessage("m1", "newest")],
          build_state: null
        })
      );

      const listed = (await listClientSessions()).find((s) => s.id === "drift");
      const opened = await getClientSession("drift");

      // The list and the opened chat agree, which they did not before.
      expect(listed?.title).toBe("Newest copy");
      expect(opened?.title).toBe("Newest copy");
      expect(opened?.revision).toBe(2);
      expect(JSON.stringify(opened?.messages)).toContain("newest");
    });

    it("breaks a same-millisecond tie on the higher revision", async () => {
      const mockIdb = createMockIndexedDB();
      vi.stubGlobal("indexedDB", mockIdb);
      vi.stubGlobal("localStorage", createMockLocalStorage());

      // Two layers written in the same millisecond, so `updated_at` cannot decide.
      const stamp = "2026-09-01T00:00:00.000Z";
      const record = (revision: number, title: string) => ({
        id: "tie",
        revision,
        title,
        created_at: stamp,
        updated_at: stamp,
        country_code: null,
        currency: null,
        messages: [],
        build_state: null
      });
      mockIdb._rows().set("tie", record(1, "older"));
      localStorage.setItem("pcbuildsage:session:tie", JSON.stringify(record(5, "newer")));

      const opened = await getClientSession("tie");
      expect(opened?.revision).toBe(5);
      expect(opened?.title).toBe("newer");
    });

    it("purges the fallback copies after a successful IndexedDB save", async () => {
      const mockIdb = createMockIndexedDB();
      vi.stubGlobal("indexedDB", mockIdb);
      const mockLs = createMockLocalStorage();
      vi.stubGlobal("localStorage", mockLs);

      await saveClientSession({ id: "purged", revision: 1, title: "First", messages: [] });
      // Simulate a leftover fallback copy from an earlier failed IndexedDB write.
      mockLs.setItem(
        "pcbuildsage:session:purged",
        JSON.stringify({
          id: "purged",
          revision: 0,
          title: "Stale fallback",
          created_at: "2020-01-01T00:00:00.000Z",
          updated_at: "2020-01-01T00:00:00.000Z",
          messages: []
        })
      );

      await saveClientSession({ id: "purged", revision: 2, title: "Second", messages: [] });

      expect(mockLs.getItem("pcbuildsage:session:purged")).toBeNull();
      expect((await getClientSession("purged"))?.title).toBe("Second");
    });
  });

  describe("Revision conflicts and tombstones", () => {
    it("rejects a save with an older revision than the stored copy", async () => {
      vi.stubGlobal("indexedDB", undefined);
      vi.stubGlobal("localStorage", createMockLocalStorage());

      await saveClientSession({ id: "conflict", revision: 5, title: "Winner", messages: [] });

      const failure = await saveClientSession({
        id: "conflict",
        revision: 3,
        title: "Stale overwrite",
        messages: []
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(SessionConflictError);
      expect((failure as SessionConflictError).reason).toBe("stale_revision");
      expect((failure as SessionConflictError).revision).toBe(5);
      // The newer copy is intact: the stale write did not land.
      expect((await getClientSession("conflict"))?.title).toBe("Winner");
    });

    it("keeps a deleted chat deleted: a late save cannot resurrect it", async () => {
      vi.stubGlobal("indexedDB", undefined);
      vi.stubGlobal("localStorage", createMockLocalStorage());

      await saveClientSession({ id: "gone", revision: 1, title: "Doomed", messages: [] });
      await deleteClientSession("gone");

      const failure = await saveClientSession({
        id: "gone",
        revision: 2,
        title: "Resurrected",
        messages: []
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(SessionConflictError);
      expect((failure as SessionConflictError).reason).toBe("session_deleted");
      expect(await getClientSession("gone")).toBeNull();
      expect(await listClientSessions()).toEqual([]);
    });

    it("the tombstone survives a reload", async () => {
      const mockLs = createMockLocalStorage();
      vi.stubGlobal("indexedDB", undefined);
      vi.stubGlobal("localStorage", mockLs);

      await saveClientSession({ id: "gone-2", revision: 1, title: "Doomed", messages: [] });
      await deleteClientSession("gone-2");

      // Simulate a page reload: module state is dropped, the storage layer is not.
      resetClientStoreState();
      vi.stubGlobal("localStorage", mockLs);

      expect(mockLs.getItem("pcbuildsage:session_tombstones")).toContain("gone-2");
      expect(await getClientSession("gone-2")).toBeNull();
      await expect(
        saveClientSession({ id: "gone-2", revision: 2, title: "Back", messages: [] })
      ).rejects.toMatchObject({ reason: "session_deleted" });
    });

    it("a deleted chat whose row survived is not advertised in the sidebar", async () => {      // `deleteClientSession` swallows a failed IndexedDB delete, so the row can
      // outlive the tombstone. Listing it would show a chat that opens empty.
      const mockIdb = createMockIndexedDB();
      vi.stubGlobal("indexedDB", mockIdb);
      const mockLs = createMockLocalStorage();
      vi.stubGlobal("localStorage", mockLs);

      await saveClientSession({ id: "zombie", revision: 1, title: "Zombie", messages: [] });
      // Tombstone it, then put the row back as a surviving delete would.
      await deleteClientSession("zombie");
      mockIdb._rows().set("zombie", {
        id: "zombie",
        revision: 1,
        title: "Zombie",
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z",
        country_code: null,
        currency: null,
        messages: [],
        build_state: null
      });

      expect((await listClientSessions()).map((s) => s.id)).not.toContain("zombie");
      expect(await getClientSession("zombie")).toBeNull();
    });
  });

  describe("Atomic revision check and durable tombstones", () => {
    it("checks the revision and writes in one IndexedDB transaction", async () => {
      const log: string[] = [];
      const mockIdb = createMockIndexedDB({ log });
      vi.stubGlobal("indexedDB", mockIdb);
      vi.stubGlobal("localStorage", createMockLocalStorage());

      await saveClientSession({ id: "atomic", revision: 1, title: "First", messages: [] });
      const saveLog = log.filter((entry) => entry.includes("chat_sessions"));

      // The get that enforces the revision and the put that writes must share
      // one transaction: separate transactions let two tabs both pass the
      // check and overwrite each other.
      const txIds = [...new Set(saveLog.map((entry) => entry.split(":")[0]))];
      expect(txIds).toHaveLength(1);
      expect(saveLog).toContainEqual(expect.stringMatching(/^tx#\d+:get:chat_sessions$/));
      expect(saveLog).toContainEqual(expect.stringMatching(/^tx#\d+:put:chat_sessions$/));

      // And the check still refuses a stale write without touching the row.
      const failure = await saveClientSession({
        id: "atomic",
        revision: 1,
        title: "Stale",
        messages: []
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SessionConflictError);
      expect((await getClientSession("atomic"))?.title).toBe("First");
    });

    it("keeps the tombstone in IndexedDB when localStorage is unavailable", async () => {
      const mockIdb = createMockIndexedDB();
      vi.stubGlobal("indexedDB", mockIdb);
      vi.stubGlobal("localStorage", undefined);

      await saveClientSession({ id: "no-ls", revision: 1, title: "Doomed", messages: [] });
      await deleteClientSession("no-ls");
      expect(mockIdb._rows("session_tombstones").has("no-ls")).toBe(true);

      // Simulate a page reload: memory is dropped, localStorage does not exist.
      resetClientStoreState();
      vi.stubGlobal("indexedDB", mockIdb);
      vi.stubGlobal("localStorage", undefined);

      expect(await getClientSession("no-ls")).toBeNull();
      await expect(
        saveClientSession({ id: "no-ls", revision: 2, title: "Resurrected", messages: [] })
      ).rejects.toMatchObject({ reason: "session_deleted" });
    });

    it("clearClientSessions tombstones every removed session", async () => {
      const mockIdb = createMockIndexedDB();
      vi.stubGlobal("indexedDB", mockIdb);
      vi.stubGlobal("localStorage", createMockLocalStorage());

      await saveClientSession({ id: "clear-a", revision: 1, title: "A", messages: [] });
      await saveClientSession({ id: "clear-b", revision: 1, title: "B", messages: [] });
      await clearClientSessions();

      expect(await listClientSessions()).toEqual([]);
      for (const id of ["clear-a", "clear-b"]) {
        expect(mockIdb._rows("session_tombstones").has(id)).toBe(true);
        await expect(
          saveClientSession({ id, revision: 2, title: "Resurrected", messages: [] })
        ).rejects.toMatchObject({ reason: "session_deleted" });
      }
    });

    it("merges by higher revision first, updated_at only breaks ties", async () => {
      const mockIdb = createMockIndexedDB();
      vi.stubGlobal("indexedDB", mockIdb);
      const mockLs = createMockLocalStorage();
      vi.stubGlobal("localStorage", mockLs);

      // The IndexedDB copy has the higher revision but the older timestamp; the
      // localStorage copy is newer by the clock but behind by revision.
      mockIdb._rows().set("merge", {
        id: "merge",
        revision: 5,
        title: "Higher revision",
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z",
        country_code: null,
        currency: null,
        messages: [],
        build_state: null
      });
      mockLs.setItem(
        "pcbuildsage:session:merge",
        JSON.stringify({
          id: "merge",
          revision: 3,
          title: "Newer clock",
          created_at: "2026-09-01T00:00:00.000Z",
          updated_at: "2026-09-02T00:00:00.000Z",
          country_code: null,
          currency: null,
          messages: [],
          build_state: null
        })
      );

      // The revision is the monotonic write counter both tabs agree on; a clock
      // must not overrule it.
      const dbgA = await getClientSession("merge");
      expect(dbgA?.title).toBe("Higher revision");
      expect((await getClientSession("merge"))?.revision).toBe(5);
    });
  });
});

describe("IndexedDB save path honours the other layers", () => {
  afterEach(() => {
    resetClientStoreState();
    vi.unstubAllGlobals();
  });

  it("refuses to resurrect a chat whose tombstone only reached localStorage", async () => {
    resetClientStoreState();
    const idb = createMockIndexedDB();
    const ls = createMockLocalStorage();
    vi.stubGlobal("indexedDB", idb);
    vi.stubGlobal("localStorage", ls);
    await saveClientSession({ id: "z", revision: 1, title: "A", messages: [] });

    // A delete whose IndexedDB tombstone write failed: the tombstone lives only
    // in localStorage, and the IndexedDB row may still be there.
    ls.setItem("pcbuildsage:session_tombstones", JSON.stringify(["z"]));
    resetClientStoreState();

    await expect(saveClientSession({ id: "z", revision: 2, title: "Resurrected", messages: [] })).rejects.toMatchObject({
      reason: "session_deleted"
    });
  });

  it("checks the revision against a newer copy that lives only in localStorage", async () => {
    resetClientStoreState();
    const idb = createMockIndexedDB();
    const ls = createMockLocalStorage();
    vi.stubGlobal("indexedDB", idb);
    vi.stubGlobal("localStorage", ls);
    await saveClientSession({ id: "y", revision: 1, title: "idb1", messages: [] });
    // Revision 4 was written to localStorage while IndexedDB was failing.
    ls.setItem(
      "pcbuildsage:session:y",
      JSON.stringify({
        id: "y",
        revision: 4,
        title: "ls4",
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z",
        country_code: null,
        currency: null,
        messages: [],
        build_state: null
      })
    );
    expect((await getClientSession("y"))?.revision).toBe(4);

    await expect(saveClientSession({ id: "y", revision: 2, title: "stale", messages: [] })).rejects.toMatchObject({
      reason: "stale_revision",
      revision: 4
    });
    expect((await getClientSession("y"))?.title).toBe("ls4");

    // A revision above it wins and replaces both copies.
    await saveClientSession({ id: "y", revision: 5, title: "idb5", messages: [] });
    expect(await getClientSession("y")).toMatchObject({ revision: 5, title: "idb5" });
    expect(ls.getItem("pcbuildsage:session:y")).toBeNull();
  });
});
