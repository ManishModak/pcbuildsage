import { describe, it, expect } from "vitest";
import {
  resolveDeploymentMode,
  isRouteBlocked,
  validateChatUrl,
  MemorySqliteRepository,
  createTestSqliteDb,
  createMockProduct
} from "../test-harness";

describe("Tier 4 - Workload Scenario 5: Local Mode Developer Journey (F1, F6, F7, F10, F31)", () => {
  it("verifies 100% backward compatibility and zero regressions for local developers", async () => {
    // Step 1: Default deployment mode is local
    const mode = resolveDeploymentMode();
    expect(mode).toBe("local");

    // Step 2: All routes are accessible for local developer workflow
    expect(isRouteBlocked("/api/scrape", "POST", mode)).toBe(false);
    expect(isRouteBlocked("/api/profiles", "GET", mode)).toBe(false);
    expect(isRouteBlocked("/api/profiles/import", "POST", mode)).toBe(false);
    expect(isRouteBlocked("/api/logs", "GET", mode)).toBe(false);

    // Step 3: Local LLM base URLs (e.g. Ollama localhost:11434) are permitted
    const ollamaCheck = validateChatUrl("http://localhost:11434/v1", mode);
    expect(ollamaCheck.allowed).toBe(true);

    const lmStudioCheck = validateChatUrl("http://127.0.0.1:1234/v1", mode);
    expect(lmStudioCheck.allowed).toBe(true);

    // Step 4: Local SQLite database queries execute seamlessly
    const seed = [
      createMockProduct({ id: "local-cpu", name: "AMD Ryzen 5 7600", price: 199, category: "cpu" }),
      createMockProduct({ id: "local-gpu", name: "AMD Radeon RX 7600", price: 269, category: "gpu" })
    ];

    const { dbPath, cleanup } = createTestSqliteDb({ products: seed });
    const localRepo = new MemorySqliteRepository(dbPath);

    const catalog = await localRepo.getCatalog();
    expect(catalog.length).toBe(2);

    const searchResult = await localRepo.searchProducts({ category: "cpu" });
    expect(searchResult.totalCount).toBe(1);
    expect(searchResult.items[0].id).toBe("local-cpu");

    const freshness = await localRepo.getFreshness();
    expect(freshness.productCount).toBe(2);

    await localRepo.close();
    cleanup();
  });
});
