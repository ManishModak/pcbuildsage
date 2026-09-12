/**
 * src/lib/catalog/sql-driver.ts
 *
 * Minimal SQL Driver abstraction for SQLite & LibSQL/Turso.
 * Enables SqlCatalogRepository to execute queries across local better-sqlite3 and
 * remote Turso (@libsql/client) without duplicating catalog query and business policy.
 */

import Database from "better-sqlite3";
import type { Client, InArgs } from "@libsql/client";
import { getDb, closeDb } from "@/lib/db";
import type { CatalogScope } from "./repository";

export interface SqlDriver {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[], scope?: CatalogScope): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[], scope?: CatalogScope): Promise<T | null>;
  close(): Promise<void>;
  isOpen(scope?: CatalogScope): boolean;
}

export class BetterSqliteDriver implements SqlDriver {
  private customDb?: Database.Database;
  private defaultDbPath?: string;
  private isClosed = false;

  constructor(dbOrPath?: string | Database.Database) {
    if (typeof dbOrPath === "string") {
      this.defaultDbPath = dbOrPath;
    } else if (dbOrPath) {
      this.customDb = dbOrPath;
    }
  }

  getDatabase(scope?: CatalogScope): Database.Database {
    if (this.isClosed) {
      throw new Error("[SqliteCatalogRepository] Repository is closed");
    }
    if (scope?.dbPath) {
      return getDb(scope.dbPath);
    }
    if (this.customDb) {
      return this.customDb;
    }
    return getDb(this.defaultDbPath);
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = [], scope?: CatalogScope): Promise<T[]> {
    const db = this.getDatabase(scope);
    return db.prepare(sql).all(...params) as T[];
  }

  async get<T = Record<string, unknown>>(sql: string, params: unknown[] = [], scope?: CatalogScope): Promise<T | null> {
    const db = this.getDatabase(scope);
    const row = db.prepare(sql).get(...params);
    return (row as T) ?? null;
  }

  async close(): Promise<void> {
    this.isClosed = true;
    if (this.customDb) {
      try {
        if (this.customDb.open) this.customDb.close();
      } catch {
        // ignore
      }
      return;
    }
    if (this.defaultDbPath) {
      closeDb(this.defaultDbPath);
      return;
    }
    closeDb();
  }

  isOpen(scope?: CatalogScope): boolean {
    if (this.isClosed) return false;
    try {
      const db = this.getDatabase(scope);
      return db.open;
    } catch {
      return false;
    }
  }
}

type TursoClientLike = {
  open?: boolean;
  closed?: boolean;
  close?: () => Promise<void> | void;
};

export class TursoLibsqlDriver implements SqlDriver {
  private isClosedRef = { closed: false };

  constructor(public client: Client) {}

  private ensureOpen(): void {
    const clientLike = this.client as TursoClientLike;
    if (this.isClosedRef.closed || Boolean(this.client?.closed) || clientLike?.open === false) {
      throw new Error("[TursoCatalogRepository] Repository is closed");
    }
  }

  private handleError(error: unknown): never {
    const clientLike = this.client as TursoClientLike;
    if (this.isClosedRef.closed || Boolean(this.client?.closed) || clientLike?.open === false) {
      throw new Error("[TursoCatalogRepository] Repository is closed");
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[TursoCatalogRepository] Query execution failed: ${message}`, { cause: error });
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.ensureOpen();
    try {
      const res = await this.client.execute({ sql, args: params as InArgs });
      return res.rows.map((row) => ({ ...row })) as unknown as T[];
    } catch (error: unknown) {
      this.handleError(error);
    }
  }

  async get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    this.ensureOpen();
    try {
      const res = await this.client.execute({ sql, args: params as InArgs });
      if (!res.rows || res.rows.length === 0) return null;
      return { ...res.rows[0] } as unknown as T;
    } catch (error: unknown) {
      this.handleError(error);
    }
  }

  async close(): Promise<void> {
    this.isClosedRef.closed = true;
    try {
      const clientLike = this.client as TursoClientLike;
      if (clientLike && typeof clientLike.close === "function" && !clientLike.closed && clientLike.open !== false) {
        await clientLike.close();
      }
    } catch {
      // Ignore teardown errors during close
    }
  }

  isOpen(): boolean {
    const clientLike = this.client as TursoClientLike;
    return !this.isClosedRef.closed && !this.client?.closed && clientLike?.open !== false;
  }
}
