import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { compactConversation, extractUnsuccessfulSearches } from "../llm/compaction";
import type { BuildSnapshot } from "../catalog/build-snapshot";

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
});
