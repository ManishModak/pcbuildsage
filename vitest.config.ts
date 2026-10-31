import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    alias: {
      "@": path.resolve(__dirname, "./src")
    },
    // Tests get throwaway in-memory databases, never the real catalog, logs or chat sessions in data/.
    env: {
      PCBUILDSAGE_DB_PATH: ":memory:",
      PCBUILDSAGE_LOGS_DB_PATH: ":memory:",
      PCBUILDSAGE_SESSIONS_DB_PATH: ":memory:"
    },
    exclude: ["**/node_modules/**", "**/.next/**"]
  }
});
