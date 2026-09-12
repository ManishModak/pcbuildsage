import { describe, it, expect } from "vitest";
import { compactChatMessages, type IncomingChatMessage } from "../llm/messages";
import { deriveBuild } from "@/features/chat/build-derive";
import type { UIMessage } from "ai";

describe("Replay Compaction for Saved / Resumed Chats", () => {
  const sample30Products = Array.from({ length: 30 }, (_, i) => ({
    id: `gpu-${i + 1}`,
    name: `NVIDIA GeForce RTX 50${i + 50}`,
    category: "gpu",
    subcategory: null,
    price: 35000 + i * 500,
    currency: "INR",
    country_code: "IN",
    retailer: "Kryptronix",
    url: `https://example.com/gpu-${i + 1}`,
    imageUrl: `https://example.com/gpu-${i + 1}.jpg`,
    in_stock: true,
    inStock: true,
    registry_key: `nvidia-rtx-50${i + 50}`,
    specs: {
      brand: "NVIDIA",
      model: `RTX 50${i + 50}`,
      aliases: [`RTX 50${i + 50}`, `50${i + 50}`],
      sources: [`https://techpowerup.com/50${i + 50}`],
      confidence: "high",
      researched_at: "2026-08-16T15:35:00Z",
      vram_gb: 12,
      tdp_w: 200,
      length_mm: 250
    },
    offers: [
      {
        id: `gpu-${i + 1}`,
        productId: `gpu-${i + 1}`,
        retailer: "Kryptronix",
        countryCode: "IN",
        currencyCode: "INR",
        price: 35000 + i * 500,
        priceMinor: (35000 + i * 500) * 100,
        destinationUrl: `https://example.com/gpu-${i + 1}`,
        sourceType: "scraped",
        observedAt: "2026-09-12T09:25:12Z",
        lastUpdated: "2026-09-12T09:25:12Z",
        availability: "in_stock",
        inStock: true
      }
    ],
    first_seen: "2026-09-12T09:25:12Z",
    last_scraped: "2026-09-12T09:25:12Z"
  }));

  it("compacts product fields across ALL historical candidates without slicing/truncating", () => {
    const rawHistory: IncomingChatMessage[] = [
      {
        role: "user",
        content: "Best 1440p gaming build"
      },
      {
        role: "assistant",
        parts: [
          {
            type: "tool-search_products",
            toolCallId: "call-gpu",
            input: { category: "gpu", limit: 30 },
            output: {
              results: sample30Products,
              items: sample30Products, // legacy duplicate array
              total_matching: 98,
              totalCount: 98,
              returned: 30,
              has_more: true,
              hint: "Showing 30 of 98"
            }
          }
        ]
      }
    ];

    const compacted = compactChatMessages(rawHistory);

    const assistantTurn = compacted[1];
    expect(assistantTurn.parts).toBeDefined();
    expect(assistantTurn.parts).toHaveLength(1);

    const toolPart = assistantTurn.parts![0] as {
      type: string;
      output: {
        results: Array<Record<string, unknown>>;
        items?: unknown;
        total_matching: number;
        has_more: boolean;
      };
    };

    expect(toolPart.type).toBe("tool-search_products");
    // MUST PRESERVE ALL 30 CANDIDATES so historical references never vanish
    expect(toolPart.output.results).toHaveLength(30);

    // MUST DROP DUPLICATE items array
    expect(toolPart.output.items).toBeUndefined();

    // Verify each product is compacted
    const firstProduct = toolPart.output.results[0];
    expect(firstProduct.id).toBe("gpu-1");
    expect(firstProduct.price).toBe(35000);
    expect(firstProduct.offers).toBeUndefined();
    expect(firstProduct.first_seen).toBeUndefined();
    expect(firstProduct.last_scraped).toBeUndefined();
    expect(firstProduct.inStock).toBeUndefined();

    // Specs must retain hardware parameters and confidence without aliases or sources
    const specs = firstProduct.specs as Record<string, unknown>;
    expect(specs.vram_gb).toBe(12);
    expect(specs.tdp_w).toBe(200);
    expect(specs.length_mm).toBe(250);
    expect(specs.confidence).toBe("high");
    expect(specs.aliases).toBeUndefined();
    expect(specs.sources).toBeUndefined();
    expect(specs.researched_at).toBeUndefined();
  });

  it("keeps original transcript messages completely unmutated", () => {
    const originalHistory: IncomingChatMessage[] = [
      {
        role: "user",
        content: "Recommend parts"
      },
      {
        role: "assistant",
        parts: [
          {
            type: "tool-search_products",
            toolCallId: "call-1",
            output: {
              results: [sample30Products[0]],
              items: [sample30Products[0]]
            }
          }
        ]
      }
    ];

    // Deep copy snapshot for comparison
    const snapshot = JSON.parse(JSON.stringify(originalHistory));

    compactChatMessages(originalHistory);

    // Original history and parts must remain identical to snapshot
    expect(originalHistory).toEqual(snapshot);
    expect((originalHistory[1].parts![0] as { output: { items: unknown[] } }).output.items).toHaveLength(1);
    expect(
      (originalHistory[1].parts![0] as { output: { results: Array<{ offers?: unknown[] }> } }).output.results[0].offers
    ).toBeDefined();
  });

  it("supports dynamic-tool parts with toolName === 'search_products'", () => {
    const rawHistory: IncomingChatMessage[] = [
      {
        role: "user",
        content: "Check parts"
      },
      {
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "search_products",
            toolCallId: "call-dyn",
            output: {
              results: [sample30Products[0]],
              items: [sample30Products[0]]
            }
          }
        ]
      }
    ];

    const compacted = compactChatMessages(rawHistory);
    const dynPart = compacted[1].parts![0] as {
      type: string;
      toolName: string;
      output: { results: Array<Record<string, unknown>>; items?: unknown };
    };

    expect(dynPart.type).toBe("dynamic-tool");
    expect(dynPart.toolName).toBe("search_products");
    expect(dynPart.output.results).toHaveLength(1);
    expect(dynPart.output.items).toBeUndefined();
    expect(dynPart.output.results[0].offers).toBeUndefined();
  });

  it("allows build-derive to seamlessly extract parts from compact search results", () => {
    const compactOutput = {
      results: [
        {
          id: "gpu-1",
          name: "Sapphire PURE RX 7700 XT 12GB",
          category: "gpu",
          price: 42490,
          currency: "INR",
          country_code: "IN",
          retailer: "Kryptronix",
          url: "https://example.com/7700xt",
          in_stock: true,
          registry_key: "amd-rx-7700-xt"
        }
      ]
    };

    const message: UIMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [
        {
          type: "tool-search_products",
          toolCallId: "call-1",
          state: "output-available",
          input: { category: "gpu" },
          output: compactOutput
        },
        {
          type: "tool-validate_build",
          toolCallId: "call-2",
          state: "output-available",
          input: {
            parts: {
              gpu: { key: "amd-rx-7700-xt", name: "Sapphire PURE RX 7700 XT 12GB" }
            }
          },
          output: { valid: true, issues: [], resolved: {} }
        }
      ]
    };

    const derived = deriveBuild(message.parts as Parameters<typeof deriveBuild>[0], "INR");
    expect(derived).not.toBeNull();
    const gpu = derived?.components.find((c) => c.category === "gpu");
    expect(gpu).toBeDefined();
    expect(gpu?.price).toBe(42490);
    expect(gpu?.retailer).toBe("Kryptronix");
    expect(gpu?.url).toBe("https://example.com/7700xt");
  });
});
