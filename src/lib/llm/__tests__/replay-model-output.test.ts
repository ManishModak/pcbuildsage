import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { streamChat } from "../chat-engine";
import * as clientModule from "../client";
import type { AppConfig } from "@/types";
import type { ChatMessage } from "../messages";

vi.mock("../client", () => ({
  streamTextWithFallback: vi.fn(),
  generateTextWithFallback: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  appendChatLog: vi.fn().mockResolvedValue(undefined)
}));

const config: AppConfig = {
  dbPath: ":memory:",
  countryCode: "IN",
  currency: "INR",
  personality: "balanced",
  theme: "sage-dark",
  tier2Enabled: false,
  freeformConsultEnabled: false,
  llm: {
    chain: [],
    roles: {
      chat: [{ provider: "gemini", model: "gemini-2.0-flash", keySource: "none", contextLimit: 65_536 }],
      subagent: [],
      scraper: []
    }
  },
  search: { provider: "none", crawlEnabled: false }
};

const FULL_ID = "da6670a41d06377759be1c70e28f32230239c099";

// A replayed search_products result must reach the model through the tool's
// toModelOutput (short IDs, no URLs), the same view it got in the live turn.
describe("history replay uses the model-facing tool output", () => {
  it("trims a replayed search_products result", async () => {
    let sent: ModelMessage[] = [];
    vi.mocked(clientModule.streamTextWithFallback).mockImplementation((options: unknown) => {
      sent = (options as { messages: ModelMessage[] }).messages;
      return {} as never;
    });

    const searchOutput = {
      results: [
        {
          id: FULL_ID,
          name: "Intel Core i9-14900K",
          category: "cpu",
          subcategory: null,
          price: 55000,
          currency: "INR",
          country_code: "IN",
          retailer: "R",
          url: "https://example.com/x",
          in_stock: true,
          registry_key: "intel-core-i9-14900k",
          specs: null
        }
      ],
      total_matching: 1,
      totalCount: 1,
      returned: 1,
      has_more: false
    };
    const messages = [
      { id: "u1", role: "user", content: "CPU for gaming?" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool-search_products",
            toolCallId: "q1",
            state: "output-available",
            input: { category: "cpu" },
            output: searchOutput
          },
          { type: "text", text: "The i9-14900K fits." }
        ]
      },
      { id: "u2", role: "user", content: "And a board?" }
    ] as unknown as ChatMessage[];

    await streamChat(config, messages);

    const toolMessage = sent.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    const result = (toolMessage!.content as Array<{ type: string; output?: { type: string; value: unknown } }>).find(
      (c) => c.type === "tool-result"
    );
    const row = (result!.output!.value as { results: Array<Record<string, unknown>> }).results[0];
    expect(row.id).toBe(FULL_ID.slice(0, 10));
    expect(row).not.toHaveProperty("url");
    // The stored UI message keeps the full output.
    expect(searchOutput.results[0].id).toBe(FULL_ID);
  });
});
