#!/usr/bin/env tsx
/**
 * scripts/publish-catalog.ts
 *
 * CLI script to validate and publish a local SQLite catalog database snapshot
 * to the remote Turso database.
 */

import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  publishCatalogSnapshot,
  type PublishOptions,
  type PublishResult
} from "../src/lib/catalog/publisher";
import type { SnapshotValidationStats } from "../src/lib/catalog/snapshot-validator";

export interface ParsedCliArgs {
  db: string;
  dryRun: boolean;
  force: boolean;
  json: boolean;
  batchSize?: number;
  help: boolean;
}

export interface RunCliOptions {
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
  client?: PublishOptions["client"];
  batchSize?: number;
}

/**
 * Prints the CLI help message to the specified logger.
 */
export function printHelp(log: (msg: string) => void = console.log): void {
  log(`Usage: publish-catalog [options]

Publish a local SQLite catalog snapshot to the remote Turso database.

Options:
  --db <path>          Path to candidate SQLite database
                       (default: $PCBUILDSAGE_DB_PATH or data/products.db)
  --dry-run            Validate snapshot without writing to remote Turso database
  --force              Bypass validation errors and attempt publish
  --batch-size <num>   Number of records per upsert batch (default: 100)
  --json               Output structured JSON to stdout
  --help, -h           Show this help message
`);
}

/**
 * Parses command-line arguments for the publish-catalog CLI.
 */
export function parseCliArgs(args: string[] = process.argv.slice(2)): ParsedCliArgs {
  const { values, positionals } = parseArgs({
    args,
    options: {
      db: { type: "string" },
      "validate-only": { type: "boolean", default: false },
      validateOnly: { type: "boolean" },
      "dry-run": { type: "boolean", default: false },
      dryRun: { type: "boolean" },
      force: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "batch-size": { type: "string" },
      batchSize: { type: "string" },
      help: { type: "boolean", short: "h", default: false }
    },
    strict: true,
    allowPositionals: true
  });

  const rawBatch = values["batch-size"] ?? values.batchSize;
  let batchSize: number | undefined;
  if (rawBatch !== undefined) {
    const num = Number(rawBatch);
    if (!Number.isFinite(num) || num <= 0) {
      throw new Error(`Invalid --batch-size: "${rawBatch}". Must be a positive integer.`);
    }
    batchSize = Math.floor(num);
  }

  const positionalDb = positionals.find((p) => typeof p === "string" && p.trim().length > 0);
  const db =
    typeof values.db === "string" && values.db.trim().length > 0
      ? values.db
      : (positionalDb ?? (process.env.PCBUILDSAGE_DB_PATH ?? path.join(process.cwd(), "data", "products.db")));

  const isDryRun = Boolean(
    values["dry-run"] ||
    values.dryRun ||
    values["validate-only"] ||
    values.validateOnly
  );

  return {
    db,
    dryRun: isDryRun,
    force: Boolean(values.force),
    json: Boolean(values.json),
    batchSize,
    help: Boolean(values.help)
  };
}

/**
 * Outputs a formatted human-readable summary of the publish operation.
 */
export function printHumanSummary(
  parsed: ParsedCliArgs,
  result: PublishResult,
  log: (msg: string) => void = console.log
): void {
  const stats = result.stats as SnapshotValidationStats | undefined;
  log("\n--- Catalog Publication Summary ---");
  log(`Status:         ${result.success ? "SUCCESS" : "FAILED"}`);
  log(`Database:       ${parsed.db}`);
  log(`Mode:           ${result.dryRun ? "Dry Run (Validation Only)" : "Remote Publish"}`);
  log(`Run ID:         ${result.runId ?? "N/A"}`);
  log(`Total Products: ${stats?.totalProducts ?? result.publishedCount ?? 0}`);
  if (!result.dryRun) {
    log(`Published:      ${result.publishedCount}`);
  }

  if (stats?.categories && Object.keys(stats.categories).length > 0) {
    const sorted = Object.entries(stats.categories).sort(([a], [b]) => a.localeCompare(b));
    log(`Categories (${sorted.length}):`);
    for (const [cat, count] of sorted) {
      log(`  • ${cat}: ${count}`);
    }
  }

  if (stats?.retailers && Object.keys(stats.retailers).length > 0) {
    const sorted = Object.entries(stats.retailers).sort(([a], [b]) => a.localeCompare(b));
    log(`Retailers (${sorted.length}):`);
    for (const [ret, count] of sorted) {
      log(`  • ${ret}: ${count}`);
    }
  }

  if (result.errors && result.errors.length > 0) {
    log(`Errors (${result.errors.length}):`);
    for (const err of result.errors) {
      log(`  ✗ ${err}`);
    }
  }
  log("-----------------------------------\n");
}

/**
 * Main execution handler for the publish-catalog CLI.
 * Returns 0 on success, 1 on failure.
 */
export async function runPublishCatalog(
  args: string[] = process.argv.slice(2),
  io: RunCliOptions = {}
): Promise<number> {
  const stdout = io.stdout ?? console.log;
  const stderr = io.stderr ?? console.error;

  let parsed: ParsedCliArgs;
  try {
    parsed = parseCliArgs(args);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (args.includes("--json")) {
      stdout(
        JSON.stringify(
          {
            success: false,
            dryRun: false,
            dbPath: "",
            publishedCount: 0,
            runId: null,
            stats: null,
            errors: [msg]
          },
          null,
          2
        )
      );
    } else {
      stderr(`[publish-catalog] Argument error: ${msg}\n`);
      printHelp(stderr);
    }
    return 1;
  }

  if (parsed.help) {
    printHelp(stdout);
    return 0;
  }

  if (!fs.existsSync(parsed.db)) {
    const errorMsg = `Candidate database file does not exist: ${parsed.db}`;
    const missingResult: PublishResult = {
      success: false,
      publishedCount: 0,
      dryRun: parsed.dryRun,
      errors: [errorMsg]
    };

    if (parsed.json) {
      stdout(
        JSON.stringify(
          {
            success: false,
            dryRun: parsed.dryRun,
            dbPath: parsed.db,
            publishedCount: 0,
            runId: null,
            stats: null,
            errors: [errorMsg]
          },
          null,
          2
        )
      );
    } else {
      stderr(`[publish-catalog] Error: ${errorMsg}`);
      printHumanSummary(parsed, missingResult, stderr);
    }
    return 1;
  }

  if (!parsed.json) {
    stdout(`[publish-catalog] Database: ${parsed.db}`);
    if (parsed.dryRun) {
      stdout("[publish-catalog] Mode: DRY-RUN (validating snapshot, no remote writes)");
    } else {
      stdout("[publish-catalog] Mode: PUBLISH (batch upserting to remote Turso catalog)");
    }
    stdout("[publish-catalog] Validating snapshot...");
  }

  let result: PublishResult;
  try {
    result = await publishCatalogSnapshot({
      dbPath: parsed.db,
      dryRun: parsed.dryRun,
      force: parsed.force,
      batchSize: io.batchSize ?? parsed.batchSize,
      client: io.client
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    result = {
      success: false,
      publishedCount: 0,
      dryRun: parsed.dryRun,
      errors: [msg]
    };
  }

  if (parsed.json) {
    stdout(
      JSON.stringify(
        {
          success: result.success,
          dryRun: Boolean(result.dryRun || parsed.dryRun),
          dbPath: parsed.db,
          publishedCount: result.publishedCount,
          runId: result.runId ?? null,
          stats: result.stats ?? null,
          errors: result.errors ?? []
        },
        null,
        2
      )
    );
  } else {
    if (result.success) {
      if (result.dryRun) {
        stdout("[publish-catalog] Snapshot validation passed! (Dry run completed)");
      } else {
        stdout(
          `[publish-catalog] Publication completed successfully! Published ${result.publishedCount} products.`
        );
      }
      printHumanSummary(parsed, result, stdout);
    } else {
      stderr("[publish-catalog] Publication failed.");
      printHumanSummary(parsed, result, stderr);
    }
  }

  return result.success ? 0 : 1;
}

const isMain = Boolean(
  process.argv[1] &&
    (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
      process.argv[1].endsWith("publish-catalog.ts"))
);

if (isMain) {
  runPublishCatalog(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      console.error("[publish-catalog] Uncaught error:", err);
      process.exit(1);
    });
}
