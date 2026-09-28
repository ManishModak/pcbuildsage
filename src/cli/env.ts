import { fileURLToPath } from "node:url";

/** The repo's `.env` (two levels up from src/cli). */
export const PROJECT_ENV_PATH = fileURLToPath(new URL("../../.env", import.meta.url));

/**
 * Loads a dotenv file into process.env without overriding variables the
 * shell already set (process.loadEnvFile semantics). A missing file is not
 * an error; returns whether the file was loaded.
 */
export function loadEnvFileIfPresent(file: string = PROJECT_ENV_PATH): boolean {
  try {
    process.loadEnvFile(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return false;
    throw error;
  }
}
