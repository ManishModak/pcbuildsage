import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createGetCatalogTool,
  getCatalog,
  createSearchProductsTool,
  searchProducts,
  createToolRegistry
} from "@/lib/tools";
import {
  setCatalogRepository,
  resetCatalogRepositoryRegistry,
  type CatalogRepository,
  type CatalogScope,
  type GetCatalogResult,
  type SearchProductsResult
} from "@/lib/catalog";
import { resolveConfig } from "@/lib/config";

describe("Catalog Tools Repository Delegation (Phase 1)", () => {
  beforeEach(() => {
    resetCatalogRepositoryRegistry();
  });

  afterEach(() => {
    resetCatalogRepositoryRegistry();
  });

  const sampleScope: CatalogScope = {
    countryCode: "US",
    currency: "USD"
  };

  const sampleCatalogResult: GetCatalogResult = {
    categories: [
      { category: "gpu", count: 10, in_stock_count: 8, price_min: 299, price_max: 1199 }
    ],
    scope: { country_code: "US", currency: "USD" }
  };

  const sampleSearchResult: SearchProductsResult = {
    results: [
      {
        id: "gpu-1",
        name: "Test RTX 4070",
        category: "gpu",
        price: 599,
        currency: "USD",
        country_code: "US",
        retailer: "TestShop",
        url: "https://example.com/gpu1",
        in_stock: true
      }
    ],
    items: [
      {
        id: "gpu-1",
        name: "Test RTX 4070",
        category: "gpu",
        price: 599,
        currency: "USD",
        country_code: "US",
        retailer: "TestShop",
        url: "https://example.com/gpu1",
        in_stock: true
      }
    ],
    totalCount: 1,
    returned: 1
  };

  interface TestExecutableTool {
    execute(input?: unknown, options?: unknown): Promise<unknown>;
  }

  function createMockRepo(): CatalogRepository {
    return {
      getCatalog: vi.fn(async () => sampleCatalogResult),
      searchProducts: vi.fn(async () => sampleSearchResult),
      getCategoryBaseline: vi.fn(async () => ({ total: 10, in_stock_total: 8, min_price: 299, max_price: 1199 })),
      getFreshness: vi.fn(async () => ({ lastScraped: "2026-09-02T12:00:00Z", productCount: 10 }))
    };
  }

  const mockExecOptions = {
    toolCallId: "call_1",
    messages: [] as unknown[],
    context: {}
  };

  describe("get_catalog tool delegation", () => {
    it("delegates to repository passed directly as argument to getCatalog()", async () => {
      const mockRepo = createMockRepo();
      const result = await getCatalog(sampleScope, mockRepo);

      expect(mockRepo.getCatalog).toHaveBeenCalledWith(sampleScope);
      expect(result).toEqual(sampleCatalogResult);
    });

    it("delegates to repository passed in scope to getCatalog()", async () => {
      const mockRepo = createMockRepo();
      const result = await getCatalog({ ...sampleScope, repository: mockRepo });

      expect(mockRepo.getCatalog).toHaveBeenCalledWith(expect.objectContaining(sampleScope));
      expect(result).toEqual(sampleCatalogResult);
    });

    it("delegates to getCatalogRepository() when no repository is explicitly passed", async () => {
      const mockRepo = createMockRepo();
      setCatalogRepository(mockRepo);

      const result = await getCatalog(sampleScope);
      expect(mockRepo.getCatalog).toHaveBeenCalledWith(sampleScope);
      expect(result).toEqual(sampleCatalogResult);
    });

    it("createGetCatalogTool tool execute delegates to injected repository", async () => {
      const mockRepo = createMockRepo();
      const toolInstance = createGetCatalogTool(sampleScope, mockRepo) as unknown as TestExecutableTool;

      const result = await toolInstance.execute({}, mockExecOptions);
      expect(mockRepo.getCatalog).toHaveBeenCalled();
      expect(result).toEqual(sampleCatalogResult);
    });

    it("createGetCatalogTool tool execute delegates to repository in scope", async () => {
      const mockRepo = createMockRepo();
      const toolInstance = createGetCatalogTool({ ...sampleScope, repository: mockRepo }) as unknown as TestExecutableTool;

      const result = await toolInstance.execute({}, mockExecOptions);
      expect(mockRepo.getCatalog).toHaveBeenCalled();
      expect(result).toEqual(sampleCatalogResult);
    });
  });

  describe("search_products tool delegation", () => {
    const input = { category: "gpu", in_stock: true };

    it("delegates to repository passed directly as argument to searchProducts()", async () => {
      const mockRepo = createMockRepo();
      const result = await searchProducts(input, sampleScope, mockRepo);

      expect(mockRepo.searchProducts).toHaveBeenCalledWith(input, sampleScope);
      expect(result).toEqual(sampleSearchResult);
    });

    it("delegates to repository passed in scope to searchProducts()", async () => {
      const mockRepo = createMockRepo();
      const result = await searchProducts(input, { ...sampleScope, repository: mockRepo });

      expect(mockRepo.searchProducts).toHaveBeenCalledWith(input, expect.objectContaining(sampleScope));
      expect(result).toEqual(sampleSearchResult);
    });

    it("delegates to getCatalogRepository() when no repository is explicitly passed", async () => {
      const mockRepo = createMockRepo();
      setCatalogRepository(mockRepo);

      const result = await searchProducts(input, sampleScope);
      expect(mockRepo.searchProducts).toHaveBeenCalledWith(input, sampleScope);
      expect(result).toEqual(sampleSearchResult);
    });

    it("createSearchProductsTool tool execute delegates to injected repository", async () => {
      const mockRepo = createMockRepo();
      const toolInstance = createSearchProductsTool(sampleScope, mockRepo) as unknown as TestExecutableTool;

      const result = await toolInstance.execute(input, mockExecOptions);
      expect(mockRepo.searchProducts).toHaveBeenCalledWith(input, sampleScope);
      expect(result).toEqual(sampleSearchResult);
    });

    it("createSearchProductsTool tool execute delegates to repository in scope", async () => {
      const mockRepo = createMockRepo();
      const toolInstance = createSearchProductsTool({ ...sampleScope, repository: mockRepo }) as unknown as TestExecutableTool;

      const result = await toolInstance.execute(input, mockExecOptions);
      expect(mockRepo.searchProducts).toHaveBeenCalled();
      expect(result).toEqual(sampleSearchResult);
    });

    it("returns error early for invalid filters without calling repository", async () => {
      const mockRepo = createMockRepo();
      const result = await searchProducts(
        { unknown_filter: 123 } as unknown as Parameters<typeof searchProducts>[0],
        sampleScope,
        mockRepo
      );

      expect(mockRepo.searchProducts).not.toHaveBeenCalled();
      expect(result.error).toContain("Unknown filter(s): unknown_filter");
      expect(result.results).toEqual([]);
    });
  });

  describe("createToolRegistry repository support", () => {
    it("passes repository option to registered tools", async () => {
      const mockRepo = createMockRepo();
      const config = resolveConfig({ countryCode: "US", currency: "USD" });
      const tools = createToolRegistry(config, { repository: mockRepo });

      const getCatalogTool = tools.get_catalog as unknown as TestExecutableTool;
      await getCatalogTool.execute({}, mockExecOptions);
      expect(mockRepo.getCatalog).toHaveBeenCalled();

      const searchProductsTool = tools.search_products as unknown as TestExecutableTool;
      await searchProductsTool.execute({ category: "gpu" }, mockExecOptions);
      expect(mockRepo.searchProducts).toHaveBeenCalled();
    });
  });
});
