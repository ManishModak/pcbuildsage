import type { ChatUIMessage } from "@/features/chat/message";
import type { SessionSummary } from "@/types/client";
import { deriveBuildState } from "@/lib/llm/messages";
import { markInterruptedToolCalls } from "@/lib/sessions/interrupted-tools";
import { parseCompactContext, type StoredCompactContext } from "./compact-context";
import type { UIMessage } from "ai";

export type SessionConflictReason = "stale_revision" | "session_deleted";

/**
 * The browser-store twin of the server's 409 responses (`stale_revision` /
 * `session_deleted`, see `src/lib/sessions.ts`). `SessionSaveQueue` handles
 * local and hosted conflicts through one code path, so it detects this class
 * with the structural `isSessionConflict` marker instead of importing it —
 * that would create a cycle through `api-client`.
 */
export class SessionConflictError extends Error {
  readonly isSessionConflict = true;
  constructor(
    readonly reason: SessionConflictReason,
    readonly revision: number | null,
    message: string
  ) {
    super(message);
    this.name = "SessionConflictError";
  }
}

/** Why a browser-side save could not be made durable. */
export type SessionPersistenceFailure = "no_durable_storage" | "quota_exceeded";

/**
 * Thrown when a chat could not be written to any durable store in this
 * browser. The save is **not** silently accepted: nothing was persisted, so
 * the queue leaves the snapshot unacknowledged and the UI warns the user.
 */
export class SessionPersistenceError extends Error {
  readonly isSessionPersistenceError = true;
  constructor(
    readonly reason: SessionPersistenceFailure,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "SessionPersistenceError";
  }
}

export type SessionDetail = {
  id: string;
  revision: number;
  title: string | null;
  created_at: Date;
  updated_at: Date;
  country_code: string | null;
  currency: string | null;
  messages: ChatUIMessage[];
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  build_state: {} | null;
  compact_context?: StoredCompactContext | null;
};

export type SaveSessionRequest = {
  id: string;
  revision: number;
  messages: ChatUIMessage[];
  title?: string | null;
  countryCode?: string | null;
  currency?: string | null;
  compact_context?: StoredCompactContext | null;
  compactContext?: StoredCompactContext | null;
};

export type { SessionSummary, StoredCompactContext };

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
  compact_context?: StoredCompactContext | null;
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
    build_state: rec.build_state !== undefined ? rec.build_state : null,
    compact_context: parseCompactContext(rec.compact_context ?? rec.compactContext)
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
    // Interrupted tool calls are repaired in memory on read; the stored
    // transcript keeps whatever state the stream was in when it stopped.
    messages: Array.isArray(record.messages)
      ? (markInterruptedToolCalls(record.messages) as ChatUIMessage[]).map((m, idx) =>
          normalizeUIMessage(m, idx)
        )
      : [],
    build_state: record.build_state ?? null,
    compact_context: record.compact_context ?? null
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
const DB_VERSION = 2;
const STORE_NAME = "chat_sessions";
/**
 * Tombstones live in the same IndexedDB database as the sessions (a second
 * store, created by the same upgrade), so a delete survives exactly where the
 * sessions do. localStorage remains as the fallback layer and memory as the
 * last resort - the read below unions all three.
 */
const TOMBSTONE_STORE = "session_tombstones";

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
      if (!db.objectStoreNames.contains(TOMBSTONE_STORE)) {
        db.createObjectStore(TOMBSTONE_STORE, { keyPath: "id" });
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

/**
 * Settle a write on the *transaction* outcome, not on the request's.
 *
 * MDN (IDBTransaction) is explicit that a successful request does not mean the
 * data is stored: "report on the success of the request (this does not mean
 * the item has been stored successfully in the DB - for that you need
 * transaction.oncomplete)". A request error "can bubble up to an error on the
 * transaction, which aborts the transaction", so `onabort`/`onerror` mean the
 * write was rolled back. Resolving on `onsuccess` (as this file used to) can
 * therefore report a save as durable moments before it is discarded.
 *
 * What `oncomplete` does *not* promise, per the same MDN page: since Firefox 40
 * "the `complete` event is fired after the OS has been told to write the data but
 * potentially before that data has actually been flushed to disk", so "there
 * exists a small chance that the entire transaction will be lost if the OS crashes
 * or there is a loss of system power before the data is flushed to disk". Settling
 * on `oncomplete` is the strongest signal IndexedDB offers and is the right choice
 * here; it is not a power-loss guarantee, and nothing in this file claims it is.
 */
function awaitTransactionCommit(tx: IDBTransaction, request: IDBRequest, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      finish();
    };
    tx.oncomplete = () => settle(resolve);
    tx.onabort = () =>
      settle(() => reject(request.error ?? tx.error ?? new Error(`IndexedDB write aborted for ${label}`)));
    tx.onerror = () =>
      settle(() => reject(tx.error ?? request.error ?? new Error(`IndexedDB transaction failed for ${label}`)));
    // Covers a request-level error in implementations that surface it without
    // bubbling to the transaction.
    request.onerror = () => settle(() => reject(request.error ?? new Error(`IndexedDB request failed for ${label}`)));
  });
}

/**
 * Revision check and write in a single IndexedDB `readwrite` transaction: the
 * `get` and the conditional `put` are requests on the same transaction, which
 * IndexedDB serializes against every other tab's `readwrite` transaction on
 * these stores. Two tabs therefore cannot both read "revision 5 is current"
 * and both write revision 6 - the second tab's `get` sees the first tab's
 * committed `put` and loses the check instead of overwriting it.
 * (Dexie docs describe the same pattern as `db.transaction('rw', ...)` with a
 * get-then-put inside one scope; this is the raw-IDB equivalent.)
 *
 * The tombstone read joins the same transaction, so a delete racing a save in
 * another tab is refused rather than resurrected. Everything between the `get`
 * callbacks and the `put` is synchronous: awaiting in between would let the
 * transaction auto-commit before the write is queued.
 */
async function idbSaveChecked(req: SaveSessionRequest): Promise<void> {
  const db = await openIndexedDb();
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction([STORE_NAME, TOMBSTONE_STORE], "readwrite");
    } catch (err) {
      reject(err);
      return;
    }
    const fail = (error: unknown) => {
      try {
        tx.abort();
      } catch {
        // Already finished; the rejection below is what matters.
      }
      reject(error);
    };
    let sessions: IDBObjectStore;
    let tombstones: IDBObjectStore;
    try {
      sessions = tx.objectStore(STORE_NAME);
      tombstones = tx.objectStore(TOMBSTONE_STORE);
    } catch (err) {
      reject(err);
      return;
    }

    let tombstoned = false;
    const tombReq = tombstones.get(req.id);
    tombReq.onsuccess = () => {
      tombstoned = tombReq.result !== undefined && tombReq.result !== null;
      const sessionReq = sessions.get(req.id);
      sessionReq.onsuccess = () => {
        let existing: StoredClientSession | null = null;
        if (sessionReq.result) {
          existing = parseStoredSession(sessionReq.result);
        }
        let record: StoredClientSession;
        try {
          record = checkAndBuildRecord(req, existing, tombstoned);
        } catch (err) {
          fail(err);
          return;
        }
        try {
          const putReq = sessions.put(record);
          void awaitTransactionCommit(tx, putReq, `put(${record.id})`).then(resolve, reject);
        } catch (err) {
          fail(err);
        }
      };
      sessionReq.onerror = () =>
        fail(sessionReq.error || new Error(`IndexedDB get(${req.id}) failed`));
    };
    tombReq.onerror = () => fail(tombReq.error || new Error("IndexedDB tombstone read failed"));
  });
}

/**
 * Refuse a save that would clobber a newer copy or resurrect a deleted chat,
 * then build the stored record. Shared by the IndexedDB ( transactional) and
 * localStorage paths so both enforce the same rule.
 */
function checkAndBuildRecord(
  req: SaveSessionRequest,
  existing: StoredClientSession | null,
  tombstoned: boolean
): StoredClientSession {
  if (tombstoned) {
    throw new SessionConflictError(
      "session_deleted",
      null,
      `Session ${req.id} was deleted, so this save cannot recreate it.`
    );
  }

  if (existing && req.revision <= existing.revision) {
    throw new SessionConflictError(
      "stale_revision",
      existing.revision,
      `Session ${req.id} already has revision ${existing.revision}.`
    );
  }

  const now = new Date().toISOString();

  let buildState: unknown = null;
  try {
    buildState = deriveBuildState(req.messages as unknown as UIMessage[]);
  } catch {
    buildState = null;
  }

  const rawCompactContext = req.compactContext !== undefined ? req.compactContext : req.compact_context;
  const compactContext = rawCompactContext !== undefined
    ? parseCompactContext(rawCompactContext)
    : (existing?.compact_context ?? null);

  return {
    id: req.id,
    revision: req.revision,
    title: req.title !== undefined ? (req.title ?? null) : (existing?.title ?? null),
    created_at: existing ? existing.created_at : now,
    updated_at: now,
    country_code: req.countryCode !== undefined ? (req.countryCode ?? null) : (existing?.country_code ?? null),
    currency: req.currency !== undefined ? (req.currency ?? null) : (existing?.currency ?? null),
    messages: req.messages,
    build_state: buildState ?? existing?.build_state ?? null,
    compact_context: compactContext
  };
}

async function idbDelete(id: string): Promise<void> {
  const db = await openIndexedDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(id);
      void awaitTransactionCommit(tx, req, `delete(${id})`).then(resolve, reject);
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
      void awaitTransactionCommit(tx, req, "clear()").then(resolve, reject);
    } catch (err) {
      reject(err);
    }
  });
}

// ---------------------------------------------------------------------------
// Layer 2: localStorage
// ---------------------------------------------------------------------------

const LS_PREFIX = "pcbuildsage:session:";
/** Deliberately outside `LS_PREFIX` so the tombstone list is not read as a session. */
const TOMBSTONE_KEY = "pcbuildsage:session_tombstones";

/**
 * Whether localStorage accepts writes. A full store fails this probe, so it is
 * only used to pick a *write* target — never to decide whether a layer is
 * readable, or a quota problem would make every saved chat unreadable.
 */
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
  if (typeof localStorage === "undefined" || localStorage === null) return [];
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
  if (typeof localStorage === "undefined" || localStorage === null) return null;
  try {
    const raw = localStorage.getItem(LS_PREFIX + id);
    if (!raw) return null;
    return parseStoredSession(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tombstones: ids the user deleted, so a late save cannot resurrect the chat.
// Mirrors the server's `session_tombstones` table. Durable in the same layers
// as the sessions themselves - IndexedDB first, then localStorage, with an
// in-memory cache last - so a delete survives a reload no matter which layer
// is holding the sessions.
// ---------------------------------------------------------------------------

let cachedTombstones: Set<string> | null = null;

function readTombstones(): Set<string> {
  if (cachedTombstones) return cachedTombstones;
  let ids: string[] = [];
  if (isLocalStorageAvailable()) {
    try {
      const raw = localStorage.getItem(TOMBSTONE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        ids = parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
      }
    } catch {
      // A corrupt tombstone list must not block saves; start over empty.
    }
  }
  cachedTombstones = new Set(ids);
  return cachedTombstones;
}

/** The IndexedDB tombstone rows, best-effort: [] when IndexedDB is unusable. */
async function idbListTombstones(): Promise<string[]> {
  let db: IDBDatabase;
  try {
    db = await openIndexedDb();
  } catch {
    return [];
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(TOMBSTONE_STORE, "readonly");
      const store = tx.objectStore(TOMBSTONE_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const ids: string[] = [];
        for (const item of (req.result as unknown[] | undefined) || []) {
          const id = (item as { id?: unknown } | null)?.id;
          if (typeof id === "string" && id.length > 0) ids.push(id);
        }
        resolve(ids);
      };
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/** One tombstone row, settled on the transaction like every other write here. */
async function idbAddTombstone(id: string): Promise<void> {
  const db = await openIndexedDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(TOMBSTONE_STORE, "readwrite");
      const store = tx.objectStore(TOMBSTONE_STORE);
      const req = store.put({ id, deleted_at: new Date().toISOString() });
      void awaitTransactionCommit(tx, req, `tombstone(${id})`).then(resolve, reject);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Union the IndexedDB tombstones into the cache. Called at the top of every
 * store operation, so a tombstone written while localStorage was unavailable
 * is still honoured after a reload.
 */
async function loadTombstonesFromIdb(): Promise<void> {
  const ids = await idbListTombstones();
  if (ids.length === 0) return;
  const cached = readTombstones();
  let changed = false;
  for (const id of ids) {
    if (!cached.has(id)) {
      cached.add(id);
      changed = true;
    }
  }
  if (changed) writeTombstones(cached);
}

function writeTombstones(ids: Set<string>): void {
  cachedTombstones = new Set(ids);
  if (!isLocalStorageAvailable()) return;
  try {
    localStorage.setItem(TOMBSTONE_KEY, JSON.stringify([...ids]));
  } catch {
    // Keep the in-memory copy; a full storage layer will fail the save loudly.
  }
}

function isTombstoned(id: string): boolean {
  return readTombstones().has(id);
}

function addTombstone(id: string): void {
  const ids = readTombstones();
  if (ids.has(id)) return;
  ids.add(id);
  writeTombstones(ids);
}

/**
 * The durable version: every layer, so the delete survives wherever the
 * sessions live. The IndexedDB mirror is best-effort - a blocked database must
 * not fail a delete the other layers already recorded.
 */
async function addTombstoneDurable(id: string): Promise<void> {
  addTombstone(id);
  try {
    await idbAddTombstone(id);
  } catch {
    // localStorage + memory already hold it; IndexedDB will catch up next time.
  }
}

function lsSave(record: StoredClientSession): void {
  const key = LS_PREFIX + record.id;
  const serialized = JSON.stringify(record);
  try {
    localStorage.setItem(key, serialized);
  } catch (err) {
    // Never evict an older chat to make room. Silently destroying a real
    // conversation to save a newer one is not a trade the user agreed to, so
    // report the failure and let the user decide what to delete.
    if (isQuotaExceededError(err)) {
      throw new SessionPersistenceError(
        "quota_exceeded",
        "Browser storage is full, so this chat was not saved. Delete an older chat and try again.",
        { cause: err }
      );
    }
    throw new SessionPersistenceError(
      "no_durable_storage",
      "This browser blocked localStorage, so the chat could not be saved on this device.",
      { cause: err }
    );
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
// Storage Driver Detection & Management
// ---------------------------------------------------------------------------

let forcedDriver: StorageType | null = null;

/** Forces the layer a save is written to. Reads always consider every layer. */
export function _setStorageDriverForTesting(driver: StorageType | null): void {
  forcedDriver = driver;
}

export function resetClientStoreState(): void {
  resetCachedDb();
  forcedDriver = null;
  cachedTombstones = null;
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
// Newest-wins merge
// ---------------------------------------------------------------------------

/**
 * Which of two stored copies of the same session is authoritative. The higher
 * `revision` wins: it is the monotonic write counter both tabs agree on, so it
 * is the only ordering that cannot be fooled by a clock. `updated_at` only
 * breaks ties (two layers written at the same revision), so the sidebar list
 * and the session that opens can never disagree about which copy is newer.
 */
function isNewerRecord(candidate: StoredClientSession, current: StoredClientSession): boolean {
  if (candidate.revision !== current.revision) return candidate.revision > current.revision;
  return parseDateSafe(candidate.updated_at).getTime() > parseDateSafe(current.updated_at).getTime();
}

/**
 * The single newest-wins implementation behind both `listClientSessions` and
 * `getClientSession`. Feeding the layers in priority order makes the first
 * record of the returned list the winner, so callers can merge by id or look up
 * a single id with the same code.
 */
function mergeNewestById(layers: readonly (readonly StoredClientSession[])[]): StoredClientSession[] {
  const byId = new Map<string, StoredClientSession>();
  for (const layer of layers) {
    for (const record of layer) {
      const existing = byId.get(record.id);
      if (!existing || isNewerRecord(record, existing)) byId.set(record.id, record);
    }
  }
  return [...byId.values()];
}

/** Every durable layer this browser can read right now, most authoritative first. */
async function readableLayers(): Promise<StoredClientSession[][]> {
  const layers: StoredClientSession[][] = [];
  if (isIdbAvailable()) {
    try {
      layers.push(await idbList());
    } catch {
      // IndexedDB unreadable right now; localStorage below is what we have.
    }
  }
  layers.push(lsList());
  return layers;
}

/** One session read from every readable layer, for the newest-wins merge. */
async function readableSessionCopies(id: string): Promise<StoredClientSession[]> {
  const copies: StoredClientSession[] = [];
  if (isIdbAvailable()) {
    try {
      const record = await idbGet(id);
      if (record) copies.push(record);
    } catch {
      // IndexedDB unreadable right now; localStorage below is what we have.
    }
  }
  const fallback = lsGet(id);
  if (fallback) copies.push(fallback);
  return copies;
}

// ---------------------------------------------------------------------------
// Client Store Operations
// ---------------------------------------------------------------------------

/**
 * Lists all client sessions, sorted newest-first by updated_at.
 * Every readable layer is merged with the same newest-wins rule `getClientSession`
 * uses, so the sidebar never advertises a copy that opening the chat would not show.
 * Resilient against corrupted entries.
 */
export async function listClientSessions(): Promise<SessionSummary[]> {
  // Tombstoned ids are filtered here as well as on read: a delete whose IndexedDB
  // write failed leaves the row behind, and listing it would advertise a chat that
  // opens as an empty screen because `getClientSession` honours the tombstone.
  await loadTombstonesFromIdb();
  const tombstones = readTombstones();
  const merged = mergeNewestById(await readableLayers()).filter((record) => !tombstones.has(record.id));
  const summaries: SessionSummary[] = merged.map(toSessionSummary);

  // Sort newest-first by updated_at
  summaries.sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());

  return summaries;
}

/**
 * Retrieves a client session by ID, taking the newest copy across all readable
 * layers. Returns null if not found, if the stored session is corrupted, or if
 * the session was deleted (see the tombstone set).
 */
export async function getClientSession(id: string): Promise<SessionDetail | null> {
  await loadTombstonesFromIdb();
  if (isTombstoned(id)) return null;
  const record = mergeNewestById([await readableSessionCopies(id)])[0];
  if (!record) return null;
  return toSessionDetail(record);
}

/**
 * Saves a client session to storage.
 * Cascades IndexedDB -> localStorage, then **fails loudly**: a save that could
 * not be made durable throws (see `SessionPersistenceError`) instead of
 * pretending to have worked. Conflicts are refused rather than overwriting a
 * newer copy: an older revision and a deleted (tombstoned) id both throw
 * `SessionConflictError`, mirroring `src/lib/sessions.ts`.
 *
 * On IndexedDB the revision check and the write are one `readwrite`
 * transaction (see `idbSaveChecked`), so two tabs cannot both pass the check
 * and overwrite each other.
 */
export async function saveClientSession(req: SaveSessionRequest): Promise<void> {
  await loadTombstonesFromIdb();

  const type = await getEffectiveStorageType();

  if (type === "indexeddb") {
    try {
      await idbSaveChecked(req);
      // The IndexedDB copy is now authoritative, so drop the fallback copies for
      // this id. Leaving them behind is how the layers drift apart and the
      // sidebar ends up listing a copy that opening the chat would not show.
      lsDelete(req.id);
      return;
    } catch (error) {
      // A refused write is final: retrying it would fail identically, and
      // falling through would write a stale-or-deleted copy to localStorage.
      if (error instanceof SessionConflictError) throw error;
      // IndexedDB write failed (aborted, blocked, over quota). Try localStorage.
    }
  }

  if (isTombstoned(req.id)) {
    throw new SessionConflictError(
      "session_deleted",
      null,
      `Session ${req.id} was deleted, so this save cannot recreate it.`
    );
  }

  const existing = await getClientSession(req.id);
  const record = checkAndBuildRecord(req, existing ? toStoredRecord(existing) : null, false);

  // No durable layer accepted the write. `lsSave` throws a typed error the save
  // queue retries and the chat view surfaces; there is deliberately no in-memory
  // fallback, because an in-memory copy is lost the moment the tab closes.
  lsSave(record);
}

/**
 * The stored row behind a session detail, for building the next revision of a
 * record the transactional path did not already handle. Only used on the
 * localStorage fallback path.
 */
function toStoredRecord(detail: SessionDetail): StoredClientSession {
  return {
    id: detail.id,
    revision: detail.revision,
    title: detail.title,
    created_at: detail.created_at.toISOString(),
    updated_at: detail.updated_at.toISOString(),
    country_code: detail.country_code,
    currency: detail.currency,
    messages: detail.messages,
    build_state: detail.build_state ?? null,
    compact_context: detail.compact_context ?? null
  };
}

/**
 * Deletes a client session by ID across all storage layers, and tombstones the
 * id so a late save (e.g. one already in flight when the user hit delete) cannot
 * resurrect the chat.
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
  await addTombstoneDurable(id);
}

/**
 * Clears all client sessions across all storage layers. Every removed session
 * is tombstoned, so an in-flight save cannot bring a cleared chat back.
 * Tombstones themselves are kept: they only guard against resurrection, and new
 * chats always get fresh ids.
 */
export async function clearClientSessions(): Promise<void> {
  const removedIds = (await listClientSessions()).map((session) => session.id);
  if (isIdbAvailable()) {
    try {
      await idbClear();
    } catch {
      // ignore
    }
  }
  lsClear();
  for (const id of removedIds) {
    await addTombstoneDurable(id);
  }
}
