import type { ChatUIMessage } from "@/features/chat/message";
import type { SessionSummary } from "@/types/client";
import { deriveBuildState } from "@/lib/llm/messages";
import type { UIMessage } from "ai";

export type SessionDetail = {
  id: string;
  revision: number;
  title: string | null;
  created_at: Date;
  updated_at: Date;
  country_code: string | null;
  currency: string | null;
  messages: ChatUIMessage[];
  build_state: unknown | null;
};

export type SaveSessionRequest = {
  id: string;
  revision: number;
  messages: ChatUIMessage[];
  title?: string | null;
  countryCode?: string | null;
  currency?: string | null;
};

export type { SessionSummary };

export type StorageType = "indexeddb" | "localstorage" | "memory";

export type StoredClientSession = {
  id: string;
  revision: number;
  title: string | null;
  created_at: string;
  updated_at: string;
  country_code: string | null;
  currency: string | null;
  messages: unknown[];
  build_state: unknown | null;
};

export function normalizeUIMessage(m: unknown, index = 0): ChatUIMessage {
  if (typeof m !== "object" || m === null) {
    return {
      id: `msg-${index}-${crypto.randomUUID()}`,
      role: "user",
      parts: []
    } as ChatUIMessage;
  }
  const rec = m as Record<string, unknown>;
  const id = typeof rec.id === "string" && rec.id ? rec.id : `msg-${index}-${crypto.randomUUID()}`;
  const role = (rec.role === "user" || rec.role === "assistant" || rec.role === "system") ? rec.role : "user";
  const createdAt = rec.createdAt ? new Date(rec.createdAt as string | number) : undefined;

  let parts: ChatUIMessage["parts"] = [];
  if (Array.isArray(rec.parts)) {
    parts = rec.parts as ChatUIMessage["parts"];
  } else if (typeof rec.content === "string") {
    parts = [{ type: "text", text: rec.content }];
  }

  return {
    ...rec,
    id,
    role,
    createdAt,
    parts
  } as ChatUIMessage;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDateSafe(val: unknown): Date {
  if (val instanceof Date && !isNaN(val.getTime())) return val;
  if (typeof val === "string" || typeof val === "number") {
    const d = new Date(val);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

function isValidSessionRecord(obj: unknown): obj is StoredClientSession {
  if (typeof obj !== "object" || obj === null) return false;
  const rec = obj as Record<string, unknown>;
  return typeof rec.id === "string" && rec.id.trim().length > 0;
}

function parseStoredSession(raw: unknown): StoredClientSession | null {
  if (!raw) return null;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isValidSessionRecord(parsed)) return null;

  const rec = parsed as Record<string, unknown>;
  const createdAt =
    typeof rec.created_at === "string"
      ? rec.created_at
      : typeof rec.createdAt === "string"
        ? rec.createdAt
        : new Date().toISOString();

  const updatedAt =
    typeof rec.updated_at === "string"
      ? rec.updated_at
      : typeof rec.updatedAt === "string"
        ? rec.updatedAt
        : createdAt;

  return {
    id: (parsed as { id: string }).id,
    revision: typeof rec.revision === "number" ? rec.revision : 0,
    title: typeof rec.title === "string" ? rec.title : null,
    created_at: createdAt,
    updated_at: updatedAt,
    country_code:
      typeof rec.country_code === "string"
        ? rec.country_code
        : typeof rec.countryCode === "string"
          ? rec.countryCode
          : null,
    currency: typeof rec.currency === "string" ? rec.currency : null,
    messages: Array.isArray(rec.messages) ? rec.messages : [],
    build_state: rec.build_state !== undefined ? rec.build_state : null
  };
}

function toSessionDetail(record: StoredClientSession): SessionDetail {
  return {
    id: record.id,
    revision: record.revision,
    title: record.title,
    created_at: parseDateSafe(record.created_at),
    updated_at: parseDateSafe(record.updated_at),
    country_code: record.country_code,
    currency: record.currency,
    messages: Array.isArray(record.messages)
      ? record.messages.map((m, idx) => normalizeUIMessage(m, idx))
      : [],
    build_state: record.build_state ?? null
  };
}

function toSessionSummary(record: StoredClientSession): SessionSummary {
  return {
    id: record.id,
    title: record.title,
    created_at: parseDateSafe(record.created_at),
    updated_at: parseDateSafe(record.updated_at)
  };
}

function isQuotaExceededError(err: unknown): boolean {
  if (!err) return false;
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    return (
      err.name === "QuotaExceededError" ||
      err.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      err.code === 22 ||
      err.code === 1014
    );
  }
  if (err instanceof Error) {
    return err.name === "QuotaExceededError" || err.message.toLowerCase().includes("quota");
  }
  if (typeof err === "object" && (err as { name?: string }).name === "QuotaExceededError") {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Layer 1: IndexedDB
// ---------------------------------------------------------------------------

const DB_NAME = "pcbuildsage";
const DB_VERSION = 1;
const STORE_NAME = "chat_sessions";

let cachedDb: IDBDatabase | null = null;

function resetCachedDb(): void {
  if (cachedDb) {
    try {
      cachedDb.close();
    } catch {
      // ignore
    }
    cachedDb = null;
  }
}

function isIdbAvailable(): boolean {
  return typeof indexedDB !== "undefined" && indexedDB !== null;
}

function openIndexedDb(): Promise<IDBDatabase> {
  if (cachedDb) return Promise.resolve(cachedDb);

  return new Promise((resolve, reject) => {
    if (!isIdbAvailable()) {
      return reject(new Error("IndexedDB is not supported"));
    }

    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      return reject(e);
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("updated_at", "updated_at", { unique: false });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      cachedDb = db;
      db.onversionchange = () => {
        resetCachedDb();
      };
      db.onclose = () => {
        cachedDb = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      reject(request.error || new Error("Failed to open IndexedDB"));
    };

    request.onblocked = () => {
      reject(new Error("IndexedDB open was blocked"));
    };
  });
}

async function idbList(): Promise<StoredClientSession[]> {
  const db = await openIndexedDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const results: StoredClientSession[] = [];
        for (const item of req.result || []) {
          const parsed = parseStoredSession(item);
          if (parsed) results.push(parsed);
        }
        resolve(results);
      };
      req.onerror = () => reject(req.error || new Error("IndexedDB getAll failed"));
    } catch (err) {
      reject(err);
    }
  });
}

async function idbGet(id: string): Promise<StoredClientSession | null> {
  const db = await openIndexedDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(id);
      req.onsuccess = () => {
        if (!req.result) {
          resolve(null);
        } else {
          resolve(parseStoredSession(req.result));
        }
      };
      req.onerror = () => reject(req.error || new Error(`IndexedDB get(${id}) failed`));
    } catch (err) {
      reject(err);
    }
  });
}

async function idbSave(record: StoredClientSession): Promise<void> {
  const db = await openIndexedDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error(`IndexedDB put(${record.id}) failed`));
      tx.onerror = () => reject(tx.error || new Error(`IndexedDB transaction failed for ${record.id}`));
    } catch (err) {
      reject(err);
    }
  });
}

async function idbDelete(id: string): Promise<void> {
  const db = await openIndexedDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error(`IndexedDB delete(${id}) failed`));
      tx.onerror = () => reject(tx.error || new Error(`IndexedDB delete transaction failed for ${id}`));
    } catch (err) {
      reject(err);
    }
  });
}

async function idbClear(): Promise<void> {
  const db = await openIndexedDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error("IndexedDB clear failed"));
      tx.onerror = () => reject(tx.error || new Error("IndexedDB clear transaction failed"));
    } catch (err) {
      reject(err);
    }
  });
}

// ---------------------------------------------------------------------------
// Layer 2: localStorage
// ---------------------------------------------------------------------------

const LS_PREFIX = "pcbuildsage:session:";

function isLocalStorageAvailable(): boolean {
  try {
    if (typeof localStorage === "undefined" || localStorage === null) return false;
    const testKey = "__pcbuildsage_test__";
    localStorage.setItem(testKey, "1");
    localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

function lsList(): StoredClientSession[] {
  if (!isLocalStorageAvailable()) return [];
  const results: StoredClientSession[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(LS_PREFIX)) {
        try {
          const raw = localStorage.getItem(key);
          if (raw) {
            const parsed = parseStoredSession(raw);
            if (parsed) results.push(parsed);
          }
        } catch {
          // Skip corrupted JSON
        }
      }
    }
  } catch {
    // Storage access error
  }
  return results;
}

function lsGet(id: string): StoredClientSession | null {
  if (!isLocalStorageAvailable()) return null;
  try {
    const raw = localStorage.getItem(LS_PREFIX + id);
    if (!raw) return null;
    return parseStoredSession(raw);
  } catch {
    return null;
  }
}

function pruneOldestLocalStorageSession(excludeId: string): boolean {
  try {
    const all = lsList().filter((s) => s.id !== excludeId);
    if (all.length === 0) return false;
    all.sort((a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime());
    localStorage.removeItem(LS_PREFIX + all[0].id);
    return true;
  } catch {
    return false;
  }
}

function lsSave(record: StoredClientSession): void {
  if (!isLocalStorageAvailable()) {
    throw new Error("localStorage is not available");
  }
  const key = LS_PREFIX + record.id;
  const serialized = JSON.stringify(record);
  try {
    localStorage.setItem(key, serialized);
  } catch (err) {
    if (isQuotaExceededError(err)) {
      if (pruneOldestLocalStorageSession(record.id)) {
        try {
          localStorage.setItem(key, serialized);
          return;
        } catch {
          // Still failed
        }
      }
    }
    throw err;
  }
}

function lsDelete(id: string): void {
  if (!isLocalStorageAvailable()) return;
  try {
    localStorage.removeItem(LS_PREFIX + id);
  } catch {
    // ignore
  }
}

function lsClear(): void {
  if (!isLocalStorageAvailable()) return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(LS_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Layer 3: In-Memory Fallback
// ---------------------------------------------------------------------------

const memoryStore = new Map<string, StoredClientSession>();

function memList(): StoredClientSession[] {
  return Array.from(memoryStore.values()).map((v) => JSON.parse(JSON.stringify(v)));
}

function memGet(id: string): StoredClientSession | null {
  const item = memoryStore.get(id);
  return item ? JSON.parse(JSON.stringify(item)) : null;
}

function memSave(record: StoredClientSession): void {
  memoryStore.set(record.id, JSON.parse(JSON.stringify(record)));
}

function memDelete(id: string): void {
  memoryStore.delete(id);
}

function memClear(): void {
  memoryStore.clear();
}

// ---------------------------------------------------------------------------
// Storage Driver Detection & Management
// ---------------------------------------------------------------------------

let forcedDriver: StorageType | null = null;

export function _setStorageDriverForTesting(driver: StorageType | null): void {
  forcedDriver = driver;
}

export function resetClientStoreState(): void {
  resetCachedDb();
  forcedDriver = null;
  memClear();
}

export async function getEffectiveStorageType(): Promise<StorageType> {
  if (forcedDriver) return forcedDriver;

  if (isIdbAvailable()) {
    try {
      await openIndexedDb();
      return "indexeddb";
    } catch {
      // IndexedDB open failed, fall back to localStorage
    }
  }

  if (isLocalStorageAvailable()) {
    return "localstorage";
  }

  return "memory";
}

// ---------------------------------------------------------------------------
// Client Store Operations
// ---------------------------------------------------------------------------

/**
 * Lists all client sessions, sorted newest-first by updated_at.
 * Resilient against corrupted entries and quota errors.
 */
export async function listClientSessions(): Promise<SessionSummary[]> {
  const type = await getEffectiveStorageType();
  let primaryRecords: StoredClientSession[] = [];

  if (type === "indexeddb") {
    try {
      primaryRecords = await idbList();
    } catch {
      primaryRecords = lsList();
    }
  } else if (type === "localstorage") {
    primaryRecords = lsList();
  } else {
    primaryRecords = memList();
  }

  // Also include localStorage and in-memory records (in case any saved via fallback)
  const lsRecords = lsList();
  const memRecords = memList();
  const byId = new Map<string, StoredClientSession>();

  for (const record of primaryRecords) {
    byId.set(record.id, record);
  }

  for (const lsRecord of lsRecords) {
    const existing = byId.get(lsRecord.id);
    if (!existing || parseDateSafe(lsRecord.updated_at).getTime() >= parseDateSafe(existing.updated_at).getTime()) {
      byId.set(lsRecord.id, lsRecord);
    }
  }

  for (const memRecord of memRecords) {
    const existing = byId.get(memRecord.id);
    if (!existing || parseDateSafe(memRecord.updated_at).getTime() >= parseDateSafe(existing.updated_at).getTime()) {
      byId.set(memRecord.id, memRecord);
    }
  }

  const summaries: SessionSummary[] = Array.from(byId.values()).map(toSessionSummary);

  // Sort newest-first by updated_at
  summaries.sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());

  return summaries;
}

/**
 * Retrieves a client session by ID.
 * Returns null if not found or if the stored session is corrupted.
 */
export async function getClientSession(id: string): Promise<SessionDetail | null> {
  const type = await getEffectiveStorageType();
  let record: StoredClientSession | null = null;

  if (type === "indexeddb") {
    try {
      record = await idbGet(id);
    } catch {
      record = lsGet(id);
    }
  } else if (type === "localstorage") {
    record = lsGet(id);
  }

  if (!record) {
    record = lsGet(id);
  }

  if (!record) {
    record = memGet(id);
  }

  if (!record) return null;
  return toSessionDetail(record);
}

/**
 * Saves a client session to storage.
 * Cascades from IndexedDB -> localStorage -> in-memory on error or quota limit.
 */
export async function saveClientSession(req: SaveSessionRequest): Promise<void> {
  const existing = await getClientSession(req.id);
  const now = new Date().toISOString();

  let buildState: unknown = null;
  try {
    buildState = deriveBuildState(req.messages as unknown as UIMessage[]);
  } catch {
    buildState = null;
  }

  const record: StoredClientSession = {
    id: req.id,
    revision: req.revision,
    title: req.title !== undefined ? (req.title ?? null) : (existing?.title ?? null),
    created_at: existing ? existing.created_at.toISOString() : now,
    updated_at: now,
    country_code: req.countryCode !== undefined ? (req.countryCode ?? null) : (existing?.country_code ?? null),
    currency: req.currency !== undefined ? (req.currency ?? null) : (existing?.currency ?? null),
    messages: req.messages,
    build_state: buildState ?? existing?.build_state ?? null
  };

  const type = await getEffectiveStorageType();

  if (type === "indexeddb") {
    try {
      await idbSave(record);
      return;
    } catch {
      // IndexedDB save failed, fall back to localStorage
      try {
        lsSave(record);
        return;
      } catch {
        // localStorage failed, fall back to memory
        memSave(record);
        return;
      }
    }
  }

  if (type === "localstorage") {
    try {
      lsSave(record);
      return;
    } catch {
      // localStorage failed, fall back to memory
      memSave(record);
      return;
    }
  }

  memSave(record);
}

/**
 * Deletes a client session by ID across all storage layers.
 */
export async function deleteClientSession(id: string): Promise<void> {
  if (isIdbAvailable()) {
    try {
      await idbDelete(id);
    } catch {
      // ignore
    }
  }
  lsDelete(id);
  memDelete(id);
}

/**
 * Clears all client sessions across all storage layers.
 */
export async function clearClientSessions(): Promise<void> {
  if (isIdbAvailable()) {
    try {
      await idbClear();
    } catch {
      // ignore
    }
  }
  lsClear();
  memClear();
}
