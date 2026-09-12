import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { deriveBuildState, compactChatMessages, capMessages, type IncomingChatMessage } from "@/lib/llm/messages";

describe("compactChatMessages", () => {
  it("strips non-text parts from all turns except keeps tool parts for the last assistant turn", () => {
    const messages: IncomingChatMessage[] = [
      {
        role: "user",
        parts: [{ type: "text", text: "recommend a gpu" }]
      },
      {
        role: "assistant",
        parts: [
          { type: "reasoning", text: "thinking about gpus" },
          {
            type: "tool-search_products",
            toolCallId: "call-1",
            state: "output-available",
            input: { category: "gpu" },
            output: { results: [{ id: "gpu-1", name: "old-4090", price: 1500 }] }
          },
          { type: "text", text: "Here is a list." }
        ]
      },
      {
        role: "user",
        parts: [{ type: "text", text: "pick that one" }]
      },
      {
        role: "assistant",
        parts: [
          { type: "reasoning", text: "confirming choice" },
          {
            type: "tool-search_products",
            toolCallId: "call-2",
            state: "output-available",
            input: { category: "gpu" },
            output: { results: [{ id: "gpu-2", name: "new-4090", price: 1600 }] }
          },
          { type: "text", text: "Choice locked." }
        ]
      }
    ];

    const compacted = compactChatMessages(messages);
    
    // The first assistant turn's tool parts must be stripped (since it is not the last assistant turn)
    expect(compacted[1].content).toContain("Here is a list.");
    expect(compacted[1].parts).toEqual([{ type: "text", text: "Here is a list." }]);

    // The second assistant turn is the last assistant turn, so its parts must be kept with compact search output
    expect(compacted[3].parts).toBeDefined();
    expect(compacted[3].parts).toHaveLength(3);
    expect(compacted[3].parts?.[1].type).toBe("tool-search_products");
    expect((compacted[3].parts?.[1] as { output: { results: Array<{ id: string }> } }).output.results[0].id).toBe("gpu-2");
    // Ensure the original messages array and original parts were NOT mutated
    expect(messages[3].parts?.[1]).not.toBe(compacted[3].parts?.[1]);
    expect(compacted[3].content).toBeUndefined();
  });
});

describe("capMessages", () => {
  it("does not cap if length is within limit", () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      content: `msg ${i}`
    }));
    expect(capMessages(messages)).toHaveLength(10);
  });

  it("caps keeping the first user message and the last N-1 messages", () => {
    const firstUserMsg = { role: "user" as const, content: "budget: 1000" };
    const middleMessages = Array.from({ length: 50 }, (_, i) => ({
      role: (i % 2 === 0 ? "assistant" : "user") as "user" | "assistant",
      content: `middle msg ${i}`
    }));
    const messages = [firstUserMsg, ...middleMessages];

    const capped = capMessages(messages);
    expect(capped).toHaveLength(40);
    expect(capped[0]).toEqual(firstUserMsg);
    expect(capped[1].content).toBe("middle msg 11");
    expect(capped[39].content).toBe("middle msg 49");
  });
});

describe("deriveBuildState", () => {
  it("returns input.parts + a compact verdict from the LAST validate_build part", () => {
    const messages: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-validate_build",
            toolCallId: "v1",
            state: "output-available",
            input: { parts: { gpu: "old-gpu", cpu: "old-cpu" } },
            output: { valid: false, issues: [{ severity: "blocking" }] }
          }
        ]
      },
      {
        id: "a2",
        role: "assistant",
        parts: [
          {
            type: "tool-validate_build",
            toolCallId: "v2",
            state: "output-available",
            input: { parts: { gpu: "rtx-4090", cpu: "ryzen-7800x3d" } },
            output: { valid: true, issues: [] }
          }
        ]
      }
    ] as UIMessage[];

    const state = deriveBuildState(messages);
    expect(state).not.toBeNull();
    expect(state?.parts).toEqual({ gpu: "rtx-4090", cpu: "ryzen-7800x3d" });
    expect(state?.verdict).toEqual({ valid: true, blocking: 0, issues: 0 });
  });

  it("returns null when no validate_build part exists", () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-search_products",
            toolCallId: "s1",
            state: "output-available",
            input: { category: "gpu" },
            output: { results: [] }
          }
        ]
      }
    ] as UIMessage[];

    expect(deriveBuildState(messages)).toBeNull();
  });
});
