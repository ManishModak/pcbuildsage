import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { deriveBuildState, prepareModelMessages } from "../model-messages";

// A unique token buried inside the bulky tool output; compact must drop it,
// full must retain it.
const MARKER = "UNIQUE_MARKER_GPU_4090";

function conversationWithToolResult(): UIMessage[] {
  return [
    { id: "u1", role: "user", parts: [{ type: "text", text: "recommend a gpu" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "internal-thinking-trace" },
        {
          type: "tool-search_products",
          toolCallId: "call-1",
          state: "output-available",
          input: { category: "gpu" },
          output: {
            results: Array.from({ length: 8 }, (_, index) => ({
              id: `p${index}`,
              name: index === 0 ? MARKER : `card-${index}`,
              price_minor: 5000000 + index
            }))
          }
        },
        { type: "text", text: "Here are the results" }
      ]
    }
  ] as UIMessage[];
}

describe("prepareModelMessages", () => {
  it("full mode retains the raw tool output and the text/reasoning parts", async () => {
    const model = await prepareModelMessages(conversationWithToolResult(), "full");
    const serialized = JSON.stringify(model);
    expect(serialized).toContain(MARKER);
    expect(serialized).toContain("Here are the results");
    expect(serialized).toContain("internal-thinking-trace");
    expect(serialized).not.toContain("omitted");
  });

  it("compact mode strips the bulky tool output to a stub while keeping text/reasoning", async () => {
    const compact = await prepareModelMessages(conversationWithToolResult(), "compact");
    const full = await prepareModelMessages(conversationWithToolResult(), "full");
    const compactStr = JSON.stringify(compact);
    const fullStr = JSON.stringify(full);

    // The heavy payload is gone, replaced by the tiny stub…
    expect(compactStr).not.toContain(MARKER);
    expect(compactStr).toContain("omitted");
    expect(compactStr).toContain("8 results");
    // …but the conversation text and reasoning survive unchanged.
    expect(compactStr).toContain("Here are the results");
    expect(compactStr).toContain("internal-thinking-trace");
    // …and the compact history is strictly smaller than the full one.
    expect(compactStr.length).toBeLessThan(fullStr.length);
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
