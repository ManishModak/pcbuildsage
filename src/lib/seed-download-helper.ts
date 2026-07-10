import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { closeDb } from "./db";

export async function downloadSeed(
  country: string,
  options: {
    onProgress?: (percent: number, message: string) => void;
    dbPath?: string;
    releaseUrl?: string;
  } = {}
): Promise<void> {
  const normCountry = country.toLowerCase();
  const dbPath = options.dbPath || "data/products.db";
  const releaseUrlBase =
    options.releaseUrl ||
    process.env.SEED_RELEASE_URL ||
    "https://github.com/manishm/pcbuildsage/releases/download/seed-data";

  const downloadUrl = `${releaseUrlBase.replace(/\/$/, "")}/products-${normCountry}.db`;

  if (options.onProgress) {
    options.onProgress(0, `Fetching from URL: ${downloadUrl}`);
  }

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download seed database for ${country} (HTTP status ${response.status} from ${downloadUrl})`
    );
  }

  const contentLength = Number(response.headers.get("content-length")) || 0;

  if (!response.body) {
    throw new Error("Response body is empty");
  }

  // Ensure target directory exists
  mkdirSync(path.dirname(dbPath), { recursive: true });

  // Stream to a temp file, then atomically swap into place so a
  // partially-downloaded file never replaces a working database.
  const tmpPath = `${dbPath}.tmp-${Date.now()}`;
  const reader = response.body.getReader();

  try {
    let receivedLength = 0;

    async function* trackedChunks(): AsyncGenerator<Uint8Array> {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          receivedLength += value.length;
          if (contentLength > 0 && options.onProgress) {
            const percent = Math.min(99, Math.round((receivedLength / contentLength) * 100));
            options.onProgress(
              percent,
              `Downloading: ${percent}% (${(receivedLength / 1024).toFixed(0)} KB / ${(contentLength / 1024).toFixed(0)} KB)`
            );
          } else if (options.onProgress) {
            options.onProgress(50, `Downloading: ${(receivedLength / 1024).toFixed(0)} KB received...`);
          }
          yield value;
        }
      }
    }

    await pipeline(trackedChunks(), createWriteStream(tmpPath));

    // Drop any cached open connection on the target before swapping the file.
    closeDb(dbPath);

    // Delete WAL and SHM journal files to prevent transaction log replay corruption on reopen
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    try {
      if (existsSync(walPath)) unlinkSync(walPath);
      if (existsSync(shmPath)) unlinkSync(shmPath);
    } catch {
      // Best effort cleanup of stale WAL/SHM files
    }

    renameSync(tmpPath, dbPath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best effort cleanup
    }
    throw error;
  }

  if (options.onProgress) {
    options.onProgress(100, `Successfully saved seed database to ${dbPath}`);
  }
}
