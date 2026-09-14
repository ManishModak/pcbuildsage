import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Sessions live in their OWN SQLite file, decoupled from the catalog
 * `products.db`. They are personal user state (chat history) with a
 * different lifecycle than the re-scrapable catalog, so we do NOT reuse
 * `getDb()`/`initializeSchema()` from db.ts (those create the catalog
 * tables on any path). This module owns a single cached connection and
 * creates only its own `sessions` table.
 */
export const DEFAULT_SESSIONS_DB_PATH =
  process.env.PCBUILDSAGE_SESSIONS_DB_PATH ?? path.join(process.cwd(), "data", "sessions.db");

let sessionsDb: Database.Database | null = null;

/**
 * Returns the cached sessions database connection, opening it (with the
 * same pragmas as db.ts's openDb) and creating the schema on first use.
 */
export function getSessionsDb(dbPath = DEFAULT_SESSIONS_DB_PATH): Database.Database {
  if (sessionsDb && sessionsDb.open) return sessionsDb;

  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      title TEXT,
      country_code TEXT,
      currency TEXT,
      messages TEXT NOT NULL,
      build_state TEXT,
      revision INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS session_tombstones (
      id TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
  `);
  const sessionColumns = db.pragma("table_info(sessions)") as Array<{ name: string }>;
  if (!sessionColumns.some((column) => column.name === "revision")) {
    db.exec("ALTER TABLE sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
  }
  if (!sessionColumns.some((column) => column.name === "compact_context")) {
    db.exec("ALTER TABLE sessions ADD COLUMN compact_context TEXT");
  }

  sessionsDb = db;
  return db;
}

export type SessionSummary = {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
};

import type { ModelMessage } from "ai";

export type StoredCompactContext = {
  messages: ModelMessage[];
  boundaryMessageId?: string;
  snapshot?: unknown | null;
};

function isValidModelMessage(m: unknown): m is ModelMessage {
  if (!m || typeof m !== "object") return false;
  const rec = m as Record<string, unknown>;
  if (typeof rec.role !== "string") return false;
  if (!["user", "assistant", "system", "tool"].includes(rec.role)) return false;
  return rec.content !== undefined || Array.isArray(rec.parts);
}

export function parseCompactContext(raw: unknown): StoredCompactContext | null {
  if (!raw) return null;
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;

  if (Array.isArray(parsed)) {
    if (parsed.length > 0 && parsed.every(isValidModelMessage)) {
      return { messages: parsed as ModelMessage[] };
    }
    return null;
  }

  const rec = parsed as Record<string, unknown>;
  if (Array.isArray(rec.messages) && rec.messages.length > 0 && rec.messages.every(isValidModelMessage)) {
    return {
      messages: rec.messages as ModelMessage[],
      boundaryMessageId: typeof rec.boundaryMessageId === "string" ? rec.boundaryMessageId : undefined,
      snapshot: rec.snapshot ?? null
    };
  }
  return null;
}

const activeCompactingSessions = new Set<string>();

export function setSessionCompacting(sessionId: string, compacting: boolean): void {
  if (compacting) {
    activeCompactingSessions.add(sessionId);
  } else {
    activeCompactingSessions.delete(sessionId);
  }
}

export function isSessionCompacting(sessionId: string): boolean {
  return activeCompactingSessions.has(sessionId);
}

export type SessionRecord = {
  id: string;
  created_at: string;
  updated_at: string;
  title: string | null;
  country_code: string | null;
  currency: string | null;
  messages: unknown[];
  build_state: unknown | null;
  compact_context?: StoredCompactContext | null;
  revision: number;
};

export type SaveSessionInput = {
  id: string;
  revision: number;
  messages?: unknown[];
  title?: string | null;
  countryCode?: string | null;
  currency?: string | null;
  buildState?: unknown;
  compactContext?: unknown;
};

export type SaveSessionResult =
  | { status: "saved"; revision: number }
  | { status: "stale"; revision: number }
  | { status: "deleted" };

export class CorruptSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} contains invalid stored data.`);
    this.name = "CorruptSessionError";
  }
}

/**
 * Upsert a session. `created_at` is set only on insert; `updated_at` (and
 * the rest of the mutable columns) always refreshes on conflict.
 */
export function saveSession(input: SaveSessionInput): SaveSessionResult {
  const db = getSessionsDb();
  return db.transaction((): SaveSessionResult => {
    const tombstone = db.prepare("SELECT 1 FROM session_tombstones WHERE id = ?").get(input.id);
    if (tombstone) return { status: "deleted" };

    const current = db.prepare("SELECT revision FROM sessions WHERE id = ?").get(input.id) as
      | { revision: number }
      | undefined;
    if (current && input.revision <= current.revision) {
      return { status: "stale", revision: current.revision };
    }

    const now = new Date().toISOString();
    const messagesJson = input.messages !== undefined ? JSON.stringify(input.messages) : null;
    const buildStateJson =
      input.buildState !== undefined && input.buildState !== null ? JSON.stringify(input.buildState) : null;
    const compactContextJson =
      input.compactContext !== undefined && input.compactContext !== null ? JSON.stringify(input.compactContext) : null;

    db.prepare(
      `INSERT INTO sessions (id, created_at, updated_at, title, country_code, currency, messages, build_state, compact_context, revision)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, '[]'), ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         messages = CASE WHEN ? THEN excluded.messages ELSE sessions.messages END,
         title = CASE WHEN ? THEN excluded.title ELSE sessions.title END,
         country_code = CASE WHEN ? THEN excluded.country_code ELSE sessions.country_code END,
         currency = CASE WHEN ? THEN excluded.currency ELSE sessions.currency END,
         updated_at = excluded.updated_at,
         build_state = CASE WHEN ? THEN excluded.build_state ELSE sessions.build_state END,
         compact_context = CASE WHEN ? THEN excluded.compact_context ELSE sessions.compact_context END,
         revision = excluded.revision`
    ).run(
      input.id,
      now,
      now,
      input.title ?? null,
      input.countryCode ?? null,
      input.currency ?? null,
      messagesJson,
      buildStateJson,
      compactContextJson,
      input.revision,
      input.messages !== undefined ? 1 : 0,
      input.title !== undefined ? 1 : 0,
      input.countryCode !== undefined ? 1 : 0,
      input.currency !== undefined ? 1 : 0,
      input.buildState !== undefined ? 1 : 0,
      input.compactContext !== undefined ? 1 : 0
    );
    return { status: "saved", revision: input.revision };
  })();
}

/** List sessions newest-first, without the (potentially large) messages blob. */
export function listSessions(): SessionSummary[] {
  const db = getSessionsDb();
  return db
    .prepare(`SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC`)
    .all() as SessionSummary[];
}

/** Fetch a single session with `messages` (and `build_state`) JSON-parsed. */
export function getSession(id: string): SessionRecord | null {
  const db = getSessionsDb();
  const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
    | {
        id: string;
        created_at: string;
        updated_at: string;
        title: string | null;
        country_code: string | null;
        currency: string | null;
        messages: string;
        build_state: string | null;
        compact_context?: string | null;
        revision: number;
      }
    | undefined;

  if (!row) return null;

  try {
    const messages: unknown = JSON.parse(row.messages);
    if (!Array.isArray(messages)) throw new Error("messages must be an array");
    const compactContext = row.compact_context ? parseCompactContext(row.compact_context) : null;
    return {
      id: row.id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      title: row.title,
      country_code: row.country_code,
      currency: row.currency,
      messages,
      build_state: row.build_state ? (JSON.parse(row.build_state) as unknown) : null,
      compact_context: compactContext,
      revision: row.revision
    };
  } catch (err) {
    if (err instanceof CorruptSessionError) throw err;
    throw new CorruptSessionError(row.id);
  }
}

export function deleteSession(id: string): void {
  const db = getSessionsDb();
  db.transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO session_tombstones (id, deleted_at) VALUES (?, ?)`).run(id, new Date().toISOString());
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  })();
}
