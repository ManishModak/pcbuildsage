/**
 * src/lib/catalog/sqlite-repository.ts
 *
 * Local SQLite Catalog Repository adapter using better-sqlite3.
 * Inherits shared query and normalization policy from SqlCatalogRepository
 * backed by BetterSqliteDriver.
 */

import Database from "better-sqlite3";
import { resolveComponent } from "@/lib/registry";
import { listMarketsFromProfiles } from "@/lib/config/markets";
import type { MarketMetadata } from "@/lib/config/deployment";
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
  private profilesDir?: string;

  constructor(
    dbOrPath?: string | Database.Database,
    registryResolver?: RegistrySpecResolver,
    profilesDir?: string
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
    this.profilesDir = profilesDir;
  }

  /**
   * Returns supported markets metadata.
   * If the catalog has in-stock products, derives active markets dynamically from the catalog.
   * In local mode, when the catalog has no in-stock products (e.g. fresh local install),
   * lists markets from installed scraper profiles (data/profiles/*.json).
   */
  override async getMarkets(profilesDir?: string): Promise<MarketMetadata[]> {
    const catalogMarkets = await super.getMarkets();
    if (catalogMarkets.length > 0) {
      return catalogMarkets;
    }
    return listMarketsFromProfiles(profilesDir ?? this.profilesDir);
  }

  /**
   * Internal helper returning the active better-sqlite3 Database handle.
   */
  getDatabase(scope?: CatalogScope): Database.Database {
    return this.sqliteDriver.getDatabase(scope);
  }
}
