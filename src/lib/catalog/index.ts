/**
 * src/lib/catalog/index.ts
 *
 * Central export for catalog domain models, repository contracts, and the
 * runtime repository factory.
 */

import { getDeploymentMode, type DeploymentMode } from "@/lib/config/deployment";
import { SqliteCatalogRepository } from "./sqlite-repository";
import { TursoCatalogRepository } from "./turso-repository";
import type { CatalogRepository } from "./repository";

export * from "./repository";
export * from "./types";
export * from "./sql-driver";
export * from "./sql-repository";
export * from "./sqlite-repository";
export * from "./turso-repository";
export * from "./snapshot-validator";
export * from "./turso-schema";
export * from "./publisher";

export type RepositoryFactory = () => CatalogRepository;

const repositoryRegistry = new Map<string, RepositoryFactory>();
let activeRepositoryInstance: CatalogRepository | null = null;

// Register default repository factories
registerCatalogRepository("local", () => new SqliteCatalogRepository());
registerCatalogRepository("hosted-demo", () => new TursoCatalogRepository());

/**
 * Explicitly sets a custom CatalogRepository instance to be returned by getCatalogRepository().
 * Ideal for testing, mock injection, and scoped overrides.
 */
export function setCatalogRepository(repo: CatalogRepository | null): void {
  activeRepositoryInstance = repo;
}

/**
 * Registers a factory function for a deployment mode (e.g. "local", "hosted-demo").
 */
export function registerCatalogRepository(mode: string, factory: RepositoryFactory): void {
  repositoryRegistry.set(mode.trim().toLowerCase(), factory);
}

/**
 * Clears registered factories and active instance (primarily for test resets).
 */
export function resetCatalogRepositoryRegistry(): void {
  repositoryRegistry.clear();
  activeRepositoryInstance = null;
}

/**
 * Resolves and returns the appropriate CatalogRepository for the given or configured deployment mode.
 *
 * In "local" mode: returns registered local repository or falls back to default SQLite adapter.
 * In "hosted-demo" mode: returns registered Turso adapter or throws an informative error if unconfigured.
 */
export function getCatalogRepository(mode?: string): CatalogRepository {
  if (activeRepositoryInstance) {
    return activeRepositoryInstance;
  }

  const resolvedMode: DeploymentMode = getDeploymentMode(mode);
  const factory = repositoryRegistry.get(resolvedMode);
  if (factory) {
    return factory();
  }

  if (resolvedMode === "hosted-demo") {
    throw new Error(
      `[CatalogRepository] Turso repository adapter is not registered for mode "${resolvedMode}". ` +
      `Register a factory via registerCatalogRepository("hosted-demo", factory) or provide an instance via setCatalogRepository().`
    );
  }

  // Default local SQLite repository implementation
  return createDefaultLocalRepository();
}

/**
 * Default local SQLite implementation using SqliteCatalogRepository.
 */
function createDefaultLocalRepository(): CatalogRepository {
  return new SqliteCatalogRepository();
}
