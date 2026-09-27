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

async function idbSave(record: StoredClientSession): Promise<void> {
  const db = await openIndexedDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(record);
      void awaitTransactionCommit(tx, req, `put(${record.id})`).then(resolve, reject);
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
// Mirrors the server's `session_tombstones` table. Backed by localStorage so it
// survives a reload in hosted mode, with an in-memory cache to avoid re-parsing
// on every read.
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
 * Which of two stored copies of the same session is authoritative. A later
 * `updated_at` wins; when two layers were written in the same millisecond the
 * higher `revision` breaks the tie, so the sidebar list and the session that
 * opens can never disagree about which copy is newer.
 */
function isNewerRecord(candidate: StoredClientSession, current: StoredClientSession): boolean {
  const candidateAt = parseDateSafe(candidate.updated_at).getTime();
  const currentAt = parseDateSafe(current.updated_at).getTime();
  if (candidateAt !== currentAt) return candidateAt > currentAt;
  return candidate.revision > current.revision;
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
  const merged = mergeNewestById(await readableLayers());
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
 */
export async function saveClientSession(req: SaveSessionRequest): Promise<void> {
  if (isTombstoned(req.id)) {
    throw new SessionConflictError(
      "session_deleted",
      null,
      `Session ${req.id} was deleted, so this save cannot recreate it.`
    );
  }

  const existing = await getClientSession(req.id);
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

  const record: StoredClientSession = {
    id: req.id,
    revision: req.revision,
    title: req.title !== undefined ? (req.title ?? null) : (existing?.title ?? null),
    created_at: existing ? existing.created_at.toISOString() : now,
    updated_at: now,
    country_code: req.countryCode !== undefined ? (req.countryCode ?? null) : (existing?.country_code ?? null),
    currency: req.currency !== undefined ? (req.currency ?? null) : (existing?.currency ?? null),
    messages: req.messages,
    build_state: buildState ?? existing?.build_state ?? null,
    compact_context: compactContext
  };

  const type = await getEffectiveStorageType();

  if (type === "indexeddb") {
    try {
      await idbSave(record);
      // The IndexedDB copy is now authoritative, so drop the fallback copies for
      // this id. Leaving them behind is how the layers drift apart and the
      // sidebar ends up listing a copy that opening the chat would not show.
      lsDelete(req.id);
      return;
    } catch {
      // IndexedDB write failed (aborted, blocked, over quota). Try localStorage.
    }
  }

  // No durable layer accepted the write. `lsSave` throws a typed error the save
  // queue retries and the chat view surfaces; there is deliberately no in-memory
  // fallback, because an in-memory copy is lost the moment the tab closes.
  lsSave(record);
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
  addTombstone(id);
}

/**
 * Clears all client sessions across all storage layers. Tombstones are kept:
 * they only guard against resurrecting deleted chats, and new chats always get
 * fresh ids.
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
}
