/**
 * src/lib/catalog/turso-repository.ts
 *
 * Remote Turso Cloud CatalogRepository adapter for PCBuildSage (Phase 1).
 * Implements authoritative catalog access over remote LibSQL protocol using @libsql/client.
 * Inherits shared query and normalization policy from SqlCatalogRepository backed by TursoLibsqlDriver.
 */

import { createClient, type Client } from "@libsql/client";
import { resolveComponent } from "@/lib/registry";
import { TursoLibsqlDriver } from "./sql-driver";
import {
  SqlCatalogRepository,
  type RegistrySpecResolver
} from "./sql-repository";

export interface TursoCatalogRepositoryOptions {
  url?: string;
  authToken?: string;
  client?: Client;
}

export class TursoCatalogRepository extends SqlCatalogRepository {
  public client: Client;

  constructor(
    options?: TursoCatalogRepositoryOptions | Client,
    registryResolver?: RegistrySpecResolver
  ) {
    let client: Client;
    if (options && "execute" in options && typeof (options as Client).execute === "function") {
      client = options as Client;
    } else {
      const opts = options as TursoCatalogRepositoryOptions | undefined;
      if (opts?.client) {
        client = opts.client;
      } else {
        const url = opts?.url ?? process.env.TURSO_DATABASE_URL;
        const authToken = opts?.authToken ?? process.env.TURSO_READ_TOKEN ?? process.env.TURSO_AUTH_TOKEN;

        if (!url || !url.trim()) {
          throw new Error(
            "[TursoCatalogRepository] Missing required Turso database URL. " +
            "Provide `url` in constructor options or set the TURSO_DATABASE_URL environment variable."
          );
        }

        try {
          client = createClient({
            url,
            authToken: authToken || undefined
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `[TursoCatalogRepository] Failed to initialize Turso client: ${msg}`,
            { cause: err }
          );
        }
      }
    }

    const driver = new TursoLibsqlDriver(client);
    const resolver: RegistrySpecResolver =
      registryResolver ??
      ((product) => {
        // Explicit registry boundary: skip local SQLite getDb() fallback
        return resolveComponent(
          {
            key: product.registry_key ?? undefined,
            name: product.normalized_name ?? product.name,
            category: product.category
          },
          { skipDbLookup: true }
        );
      });

    super(driver, resolver);
    this.client = client;
  }
}
