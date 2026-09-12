/**
 * src/lib/catalog/sqlite-repository.ts
 *
 * Local SQLite Catalog Repository adapter using better-sqlite3.
 * Inherits shared query and normalization policy from SqlCatalogRepository
 * backed by BetterSqliteDriver.
 */

import Database from "better-sqlite3";
import { resolveComponent } from "@/lib/registry";
import { BetterSqliteDriver } from "./sql-driver";
import {
  SqlCatalogRepository,
  BUILD_RELEVANT_SQL,
  type RegistrySpecResolver
} from "./sql-repository";
import type { CatalogScope } from "./repository";

export { BUILD_RELEVANT_SQL };

export class SqliteCatalogRepository extends SqlCatalogRepository {
  private sqliteDriver: BetterSqliteDriver;

  constructor(
    dbOrPath?: string | Database.Database,
    registryResolver?: RegistrySpecResolver
  ) {
    const driver = new BetterSqliteDriver(dbOrPath);
    const resolver: RegistrySpecResolver =
      registryResolver ??
      ((product, scope?: CatalogScope) => {
        const db = driver.getDatabase(scope);
        return resolveComponent(
          {
            key: product.registry_key ?? undefined,
            name: product.normalized_name ?? product.name,
            category: product.category
          },
          { db }
        );
      });

    super(driver, resolver);
    this.sqliteDriver = driver;
  }

  /**
   * Internal helper returning the active better-sqlite3 Database handle.
   */
  getDatabase(scope?: CatalogScope): Database.Database {
    return this.sqliteDriver.getDatabase(scope);
  }
}
