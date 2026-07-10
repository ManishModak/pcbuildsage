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
      build_state TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
  `);

  sessionsDb = db;
  return db;
}

export type SessionSummary = {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
};

export type SessionRecord = {
  id: string;
  created_at: string;
  updated_at: string;
  title: string | null;
  country_code: string | null;
  currency: string | null;
  messages: unknown[];
  build_state: unknown | null;
};

export type SaveSessionInput = {
  id: string;
  messages: unknown[];
  title?: string | null;
  countryCode?: string | null;
  currency?: string | null;
  buildState?: unknown;
};

/**
 * Upsert a session. `created_at` is set only on insert; `updated_at` (and
 * the rest of the mutable columns) always refreshes on conflict.
 */
export function saveSession(input: SaveSessionInput): void {
  const db = getSessionsDb();
  const now = new Date().toISOString();
  const messagesJson = JSON.stringify(input.messages ?? []);
  const buildStateJson = input.buildState !== undefined ? JSON.stringify(input.buildState) : null;

  db.prepare(
    `INSERT INTO sessions (id, created_at, updated_at, title, country_code, currency, messages, build_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       messages = excluded.messages,
       title = excluded.title,
       country_code = excluded.country_code,
       currency = excluded.currency,
       updated_at = excluded.updated_at,
       build_state = excluded.build_state`
  ).run(input.id, now, now, input.title ?? null, input.countryCode ?? null, input.currency ?? null, messagesJson, buildStateJson);
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
      }
    | undefined;

  if (!row) return null;

  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    title: row.title,
    country_code: row.country_code,
    currency: row.currency,
    messages: JSON.parse(row.messages) as unknown[],
    build_state: row.build_state ? (JSON.parse(row.build_state) as unknown) : null
  };
}

export function deleteSession(id: string): void {
  const db = getSessionsDb();
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}
