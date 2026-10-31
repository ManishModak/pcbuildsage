import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import {
  compactConversation,
  extractUnsuccessfulSearches,
  extractRecentSearchShortlist,
  extractBuildSnapshots,
  formatShortlistForContext
} from "../llm/compaction";
import type { BuildSnapshot } from "../catalog/build-snapshot";
import { RESERVED_OUTPUT_TOKENS } from "../llm/context-budget";

type JsonSerializable =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonSerializable }
  | JsonSerializable[];

// Mock client.generateTextWithFallback
vi.mock("../llm/client", () => ({
  generateTextWithFallback: vi.fn().mockImplementation(async () => {
    return {
      text: "User is building a $1500 gaming rig. Selected Ryzen 7600X and RTX 4070. Motherboard searched was OOS. Next step: find compatible B650 board.",
      model: "test-model"
    };
  })
}));

describe("compaction", () => {
  describe("extractUnsuccessfulSearches", () => {
    it("extracts 0-match and error search results", () => {
      const messages: ModelMessage[] = [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "search_products",
              output: {
                type: "json",
                value: { results: [], total_matching: 0, in_stock_total: 0 }
              }
            }
          ]
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-2",
              toolName: "search_products",
              output: {
                type: "json",
                value: { results: [{ id: "p1" }], total_matching: 1, in_stock_total: 1 }
              }
            }
          ]
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-3",
              toolName: "search_products",
              output: {
                type: "json",
                value: { error: "Catalog timeout" }
              }
            }
          ]
        }
      ];

      const deadEnds = extractUnsuccessfulSearches(messages);
      expect(deadEnds).toHaveLength(2);
      expect(deadEnds).toContain("search_products returned 0 in-stock results");
      expect(deadEnds).toContain("search_products returned Error: Catalog timeout");
    });
  });

  describe("compactConversation", () => {
    const mockSnapshot: BuildSnapshot = {
      label: "Gaming Rig",
      components: [
        {
          category: "gpu",
          product_id: "rtx-4070",
          name: "RTX 4070",
          price: 549.99,
          currency: "USD",
          included: false
        }
      ],
      total: 549.99,
      subtotal: 549.99,
      currency: "USD",
      is_complete: true,
      component_count: 1,
      unpriced_count: 0,
      missing_prices: [],
      currencies: ["USD"],
      parts: { gpu: { product_id: "rtx-4070" } },
      valid: true,
      created_at: "2026-09-14T00:00:00Z"
    };

    it("does not compact when usage is well below threshold", async () => {
      const messages: ModelMessage[] = [
        { role: "user", content: "Build me a computer" },
        { role: "assistant", content: "What is your budget?" }
      ];

      const res = await compactConversation({
        chain: [{ provider: "gemini", model: "gemini-2.0-flash", keySource: "none" }],
        systemPrompt: "You are a helpful assistant.",
        messages,
        snapshot: mockSnapshot,
        contextLimit: 32768
      });

      expect(res.compacted).toBe(false);
      expect(res.messages).toBe(messages);
    });

    it("triggers compaction when usage crosses 78% of contextLimit", async () => {
      // Create a large conversation that exceeds 78% of 8,192 limit (~6,400 tokens)
      const bigText = "A".repeat(25000); // ~7,100 tokens
      const messages: ModelMessage[] = [
        { role: "user", content: "I want a $1500 gaming PC" },
        { role: "assistant", content: bigText },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "val-1",
              toolName: "validate_build",
              input: { parts: { gpu: { product_id: "rtx-4070" } } }
            }
          ]
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "val-1",
              toolName: "validate_build",
              output: {
                type: "json",
                value: { valid: true }
              }
            }
          ]
        }
      ];

      const res = await compactConversation({
        chain: [{ provider: "gemini", model: "gemini-2.0-flash", keySource: "none" }],
        systemPrompt: "You are a PC building assistant.",
        messages,
        snapshot: mockSnapshot,
        contextLimit: 8192
      });

      expect(res.compacted).toBe(true);
      if (!res.compacted) throw new Error("Expected compaction to succeed");
      expect(res.handoffText).toBeDefined();
      expect(res.tokensAfter).toBeLessThan(res.tokensBefore);

      // Verify that initial prompt is preserved
      expect(res.messages[0]).toEqual({
        role: "user",
        content: "I want a $1500 gaming PC"
      });

      // Verify handoff assistant message
      expect(res.messages[1].role).toBe("assistant");
      expect((res.messages[1].content as string)).toContain("[Progress & Handoff Summary]");

      // Verify build snapshot inclusion
      const snapshotMsg = res.messages.find((m) =>
        typeof m.content === "string" && m.content.includes("[Authoritative Build Snapshot]")
      );
      expect(snapshotMsg).toBeDefined();
      expect((snapshotMsg?.content as string)).toContain("RTX 4070");

      // Verify retention of the recent tool-call and tool-result pair
      const toolMsg = res.messages.find((m) => m.role === "tool");
      expect(toolMsg).toBeDefined();
    });

    it("aborts safely without corrupting messages if handoff generation fails", async () => {
      const { generateTextWithFallback } = await import("../llm/client");
      vi.mocked(generateTextWithFallback).mockRejectedValueOnce(new Error("LLM failure"));

      const bigText = "A".repeat(25000);
      const messages: ModelMessage[] = [
        { role: "user", content: "Build me a PC" },
        { role: "assistant", content: bigText }
      ];

      const res = await compactConversation({
        chain: [{ provider: "gemini", model: "gemini-2.0-flash", keySource: "none" }],
        systemPrompt: "System",
        messages,
        contextLimit: 8192
      });

      expect(res.compacted).toBe(false);
      if (res.compacted) throw new Error("Expected compaction to fail");
      expect(res.messages).toBe(messages);
      expect(res.reason).toContain("Handoff generation failed");
    });
  });

  describe("Track C Challenger Requirements", () => {
    const makeSnapshot = (label: string, gpuName: string, gpuId: string, price: number): BuildSnapshot => ({
      label,
      components: [
        {
          category: "gpu",
          product_id: gpuId,
          name: gpuName,
          price,
          currency: "USD",
          included: false
        }
      ],
      total: price,
      subtotal: price,
      currency: "USD",
      is_complete: true,
      component_count: 1,
      unpriced_count: 0,
      missing_prices: [],
      currencies: ["USD"],
      parts: { gpu: { product_id: gpuId } },
      valid: true,
      created_at: "2026-09-14T00:00:00Z"
    });

    const budgetSnapshot = makeSnapshot("Within budget", "RTX 4060", "rtx-4060-id", 299.99);
    const upgradeSnapshot = makeSnapshot("Small upgrade", "RTX 4070", "rtx-4070-id", 549.99);
    const maxPerfSnapshot = makeSnapshot("Max Performance", "RTX 4080 Super", "rtx-4080-id", 999.99);

    // Item 1: Latest user message survives word for word alongside first user message
    it("Item 1: preserves latest user message word for word alongside the first user message", async () => {
      const bigFiller = "Assistant commentary: ".repeat(1500); // Exceeds threshold (~7000 tokens)
      const fixtureMessages: ModelMessage[] = [
        { role: "user", content: "I need a high-end gaming PC for 1440p 240Hz under $1500." },
        { role: "assistant", content: bigFiller },
        { role: "user", content: "make it a white case" },
        { role: "assistant", content: "Understood, checking white cases." }
      ];

      const res = await compactConversation({
        chain: [{ provider: "gemini", model: "gemini-2.0-flash", keySource: "none" }],
        systemPrompt: "You are a PC building assistant.",
        messages: fixtureMessages,
        contextLimit: 8192,
        force: true
      });

      expect(res.compacted).toBe(true);
      if (!res.compacted) throw new Error("Expected compaction to succeed");

      // First user message is preserved word for word
      expect(res.messages[0]).toEqual({
        role: "user",
        content: "I need a high-end gaming PC for 1440p 240Hz under $1500."
      });

      // Latest user message is preserved word for word alongside the first one
      const syntheticMsg = res.messages[2];
      expect(syntheticMsg.role).toBe("user");
      expect(syntheticMsg.content as string).toContain("[Latest User Request]\nmake it a white case");
      expect(syntheticMsg.content as string).toContain("make it a white case");
    });

    // Item 2: Shortlist of recent search_products results (ID, category, name, price, max ~20 rows)
    it("Item 2: extracts and includes shortlist of recent search_products results (ID, category, name, price, max 20 rows)", async () => {
      // 25 distinct search products returned across 2 tool results
      const searchResults1 = Array.from({ length: 15 }, (_, i) => ({
        id: `gpu-${i + 1}`,
        name: `NVIDIA GeForce RTX 40${i + 50}`,
        category: "gpu",
        price: 300 + i * 20,
        currency: "USD"
      }));
      const searchResults2 = Array.from({ length: 10 }, (_, i) => ({
        id: `cpu-${i + 1}`,
        name: `AMD Ryzen ${i + 7000}`,
        category: "cpu",
        price: 200 + i * 15,
        currency: "USD"
      }));

      const fixtureMessages: ModelMessage[] = [
        { role: "user", content: "Find parts for my build" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "search-1",
              toolName: "search_products",
              input: { category: "gpu" }
            }
          ]
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "search-1",
              toolName: "search_products",
              output: {
                type: "json",
                value: { results: searchResults1, total_matching: 15 }
              }
            }
          ]
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "search-2",
              toolName: "search_products",
              input: { category: "cpu" }
            }
          ]
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "search-2",
              toolName: "search_products",
              output: {
                type: "json",
                value: { results: searchResults2, total_matching: 10 }
              }
            }
          ]
        }
      ];

      // Test extraction helper
      const shortlist = extractRecentSearchShortlist(fixtureMessages, 20);
      expect(shortlist).toHaveLength(20);
      // Verify recent items (CPUs from search-2) are captured first
      expect(shortlist.some((p) => p.id === "cpu-1")).toBe(true);
      expect(shortlist[0]).toMatchObject({
        id: expect.any(String),
        category: expect.any(String),
        name: expect.any(String),
        price: expect.any(Number)
      });

      // Test shortlist formatting directly
      const formatted = formatShortlistForContext(shortlist.slice(0, 1));
      expect(formatted).toContain("- [cpu-1] (cpu) AMD Ryzen 7000 — USD 200");

      // Test compaction integration
      const res = await compactConversation({
        chain: [{ provider: "gemini", model: "gemini-2.0-flash", keySource: "none" }],
        systemPrompt: "You are a PC building assistant.",
        messages: fixtureMessages,
        contextLimit: 8192,
        force: true
      });

      expect(res.compacted).toBe(true);
      if (!res.compacted) throw new Error("Expected compaction to succeed");

      const syntheticMsg = res.messages[2];
      expect(syntheticMsg.role).toBe("user");
      const content = syntheticMsg.content as string;
      expect(content).toContain("[Recent Search Shortlist]");
      // Contains ID, category, name, and price format
      expect(content).toMatch(/- \[[a-z0-9-]+\] \([a-z]+\) .+ — (USD )?\d+/);
      expect(content).toContain("[cpu-1] (cpu) AMD Ryzen 7000 — USD 200");

      // Verify row count limit
      const shortlistLines = content
        .split("\n")
        .filter((l) => l.startsWith("- ["));
      expect(shortlistLines.length).toBeLessThanOrEqual(20);
    });

    // Item 3: Batched validate_build outputs with builds keyed by label carry ALL build snapshots
    it("Item 3: carries ALL build snapshots from batched validate_build output keyed by label", async () => {
      const filler = "Previous assistant research text. ".repeat(1200);
      const fixtureMessages: ModelMessage[] = [
        { role: "user", content: "Propose 3 builds with different budget tradeoffs" },
        { role: "assistant", content: filler },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "val-batch",
              toolName: "validate_build",
              input: {
                builds: [
                  { label: "Within budget", parts: { gpu: "rtx-4060-id" } },
                  { label: "Small upgrade", parts: { gpu: "rtx-4070-id" } },
                  { label: "Max Performance", parts: { gpu: "rtx-4080-id" } }
                ]
              }
            }
          ]
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "val-batch",
              toolName: "validate_build",
              output: {
                type: "json",
                value: {
                  builds: {
                    "Within budget": { valid: true, snapshot: budgetSnapshot },
                    "Small upgrade": { valid: true, snapshot: upgradeSnapshot },
                    "Max Performance": { valid: true, snapshot: maxPerfSnapshot }
                  },
                  // First build spread at top level per PR #18
                  valid: true,
                  snapshot: budgetSnapshot
                } as unknown as JsonSerializable
              }
            }
          ]
        }
      ];

      // Test snapshot extraction
      const extractedSnapshots = extractBuildSnapshots(fixtureMessages);
      expect(extractedSnapshots).toHaveLength(3);
      expect(extractedSnapshots.map((s) => s.label)).toEqual([
        "Within budget",
        "Small upgrade",
        "Max Performance"
      ]);

      // Test compaction integration
      const res = await compactConversation({
        chain: [{ provider: "gemini", model: "gemini-2.0-flash", keySource: "none" }],
        systemPrompt: "You are a PC building assistant.",
        messages: fixtureMessages,
        contextLimit: 8192,
        force: true
      });

      expect(res.compacted).toBe(true);
      if (!res.compacted) throw new Error("Expected compaction to succeed");

      const syntheticMsg = res.messages[2];
      const content = syntheticMsg.content as string;
      expect(content).toContain("[Authoritative Build Snapshot]");
      expect(content).toContain("Label: Within budget");
      expect(content).toContain("Label: Small upgrade");
      expect(content).toContain("Label: Max Performance");
      expect(content).toContain("RTX 4060");
      expect(content).toContain("RTX 4070");
      expect(content).toContain("RTX 4080 Super");
      expect(content).toContain("Total: USD 299.99");
      expect(content).toContain("Total: USD 549.99");
      expect(content).toContain("Total: USD 999.99");
    });

    // Item 4: Failed searches with term instead of query are correctly extracted as search history notes
    it("Item 4: extracts failed searches using term as well as query", () => {
      const messages: ModelMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "search-term-call",
              toolName: "search_products",
              input: {
                category: "case",
                term: "Lian Li O11 Vision White",
                price_max: 150
              }
            },
            {
              type: "tool-call",
              toolCallId: "search-query-call",
              toolName: "search_products",
              input: {
                category: "cooler",
                query: "Kraken Elite 360 RGB",
                price_max: 200
              }
            }
          ]
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "search-term-call",
              toolName: "search_products",
              output: {
                type: "json",
                value: {
                  results: [],
                  total_matching: 0,
                  in_stock_total: 0
                }
              }
            },
            {
              type: "tool-result",
              toolCallId: "search-query-call",
              toolName: "search_products",
              output: {
                type: "json",
                value: {
                  error: "Supplier catalog timeout"
                }
              }
            }
          ]
        }
      ];

      const deadEnds = extractUnsuccessfulSearches(messages);
      expect(deadEnds).toHaveLength(2);
      expect(deadEnds).toContain(
        'search_products (category: case, query: "Lian Li O11 Vision White", max: 150) returned 0 in-stock results'
      );
      expect(deadEnds).toContain(
        'search_products (category: cooler, query: "Kraken Elite 360 RGB", max: 200) returned Error: Supplier catalog timeout'
      );
    });

    // Item 5: Merged synthetic context into one user message, strictly alternating roles, fits under headroom
    it("Item 5: merges synthetic context into one user message, enforces strictly alternating roles, and satisfies headroom check", async () => {
      const bigFiller = "Assistant reasoning text. ".repeat(1200);
      const fixtureMessages: ModelMessage[] = [
        { role: "user", content: "Build a $1500 editing workstation" },
        { role: "assistant", content: bigFiller },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "dead-call",
              toolName: "search_products",
              input: { category: "gpu", term: "RTX 4090", price_max: 1000 }
            }
          ]
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "dead-call",
              toolName: "search_products",
              output: {
                type: "json",
                value: { results: [], in_stock_total: 0 }
              }
            }
          ]
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "good-call",
              toolName: "search_products",
              input: { category: "gpu" }
            }
          ]
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "good-call",
              toolName: "search_products",
              output: {
                type: "json",
                value: {
                  results: [
                    { id: "rtx-4070-ti", name: "RTX 4070 Ti Super", category: "gpu", price: 799.99, currency: "USD" }
                  ]
                }
              }
            }
          ]
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "batch-val",
              toolName: "validate_build",
              input: {
                builds: [
                  { label: "Option A", parts: { gpu: "rtx-4070-ti" } },
                  { label: "Option B", parts: { gpu: "rtx-4070-id" } }
                ]
              }
            }
          ]
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "batch-val",
              toolName: "validate_build",
              output: {
                type: "json",
                value: {
                  builds: {
                    "Option A": { valid: true, snapshot: makeSnapshot("Option A", "RTX 4070 Ti Super", "rtx-4070-ti", 799.99) },
                    "Option B": { valid: true, snapshot: makeSnapshot("Option B", "RTX 4070", "rtx-4070-id", 549.99) }
                  },
                  snapshot: makeSnapshot("Option A", "RTX 4070 Ti Super", "rtx-4070-ti", 799.99)
                } as unknown as JsonSerializable
              }
            }
          ]
        },
        { role: "user", content: "make it a white case" },
        { role: "assistant", content: "I will update the build with a white case." }
      ];

      const contextLimit = 8192;
      const res = await compactConversation({
        chain: [{ provider: "gemini", model: "gemini-2.0-flash", keySource: "none" }],
        systemPrompt: "You are PCBuildSage.",
        messages: fixtureMessages,
        contextLimit,
        force: true
      });

      expect(res.compacted).toBe(true);
      if (!res.compacted) throw new Error("Expected compaction to succeed");

      // Verify that resumed messages strictly alternate roles: [user, assistant, user]
      const roles = res.messages.map((m) => m.role);
      expect(roles).toEqual(["user", "assistant", "user"]);

      for (let i = 0; i < roles.length - 1; i++) {
        expect(roles[i]).not.toBe(roles[i + 1]);
      }

      // Verify single merged synthetic user message contains all required sections
      const syntheticMsg = res.messages[2];
      expect(syntheticMsg.role).toBe("user");
      const content = syntheticMsg.content as string;
      expect(content).toContain("[Authoritative Build Snapshot]");
      expect(content).toContain("Label: Option A");
      expect(content).toContain("Label: Option B");
      expect(content).toContain("[Search History Notes]");
      expect(content).toContain('query: "RTX 4090"');
      expect(content).toContain("[Recent Search Shortlist]");
      expect(content).toContain("[rtx-4070-ti] (gpu) RTX 4070 Ti Super — USD 799.99");
      expect(content).toContain("[Latest User Request]\nmake it a white case");

      // Verify headroom check
      const maxAllowedTokens = contextLimit - RESERVED_OUTPUT_TOKENS;
      expect(res.tokensAfter).toBeLessThan(maxAllowedTokens);
      expect(res.tokensAfter).toBeLessThan(res.tokensBefore);
    });
  });
});
