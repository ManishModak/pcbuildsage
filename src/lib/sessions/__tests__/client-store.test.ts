import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearClientSessions,
  deleteClientSession,
  getClientSession,
  getEffectiveStorageType,
  listClientSessions,
  resetClientStoreState,
  saveClientSession,
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

function createMockIndexedDB() {
  const stores = new Map<string, Map<string, unknown>>();

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
                    storeMap.set(val.id, JSON.parse(JSON.stringify(val)));
                    req.succeed(undefined);
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
        if (openReq.onupgradeneeded) {
          (openReq as unknown as { onupgradeneeded: () => void }).onupgradeneeded();
        }
        openReq.onsuccess?.();
      });
      return openReq;
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

  describe("In-Memory Fallback", () => {
    it("falls back to in-memory store when both IndexedDB and localStorage are unavailable", async () => {
      vi.stubGlobal("indexedDB", undefined);
      vi.stubGlobal("localStorage", undefined);

      expect(await getEffectiveStorageType()).toBe("memory");

      await saveClientSession({
        id: "mem-sess-1",
        revision: 1,
        title: "In-Memory Session",
        messages: [makeMessage("m1", "Ephemeral message")]
      });

      const retrieved = await getClientSession("mem-sess-1");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe("mem-sess-1");
      expect(retrieved?.title).toBe("In-Memory Session");
      expect(retrieved?.messages.length).toBe(1);

      const list = await listClientSessions();
      expect(list.length).toBe(1);
      expect(list[0].id).toBe("mem-sess-1");

      await deleteClientSession("mem-sess-1");
      expect(await getClientSession("mem-sess-1")).toBeNull();
      expect(await listClientSessions()).toEqual([]);
    });

    it("falls back to in-memory store when localStorage throws SecurityError", async () => {
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

      await saveClientSession({
        id: "mem-sess-2",
        revision: 1,
        title: "Fallback on security error",
        messages: []
      });

      const retrieved = await getClientSession("mem-sess-2");
      expect(retrieved?.title).toBe("Fallback on security error");
    });
  });

  describe("Sorting", () => {
    it("orders sessions newest-first by updated_at", async () => {
      _setStorageDriverForTesting("memory");

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
      _setStorageDriverForTesting("memory");

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
    it("handles localStorage quota exceeded error by evicting oldest session or falling back to memory", async () => {
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

      // Saving should not throw unhandled error; it falls back gracefully to in-memory
      await expect(
        saveClientSession({ id: "s-large", revision: 1, title: "Large Session", messages: [] })
      ).resolves.toBeUndefined();

      // It is still retrievable via getClientSession!
      const retrieved = await getClientSession("s-large");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe("s-large");
      expect(retrieved?.title).toBe("Large Session");
    });
  });
});
