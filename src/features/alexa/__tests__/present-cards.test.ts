import { describe, expect, it } from "vitest";
import { extractPresentedBuilds, hasPresentAttempt } from "../present-cards";

const CARD = { label: "Gaming build", snapshot: { total: 47889, currency: "INR" } };

function presentOutput(overrides = {}) {
  return {
    content: [{ type: "text", text: JSON.stringify({ presented: true, cards: [CARD] }) }],
    structuredContent: { presented: true, builds: [], cards: [CARD] },
    ...overrides
  };
}

function presentPart(output: unknown, extra = {}) {
  return { type: "tool-present_build", toolCallId: "call-1", state: "output-available", input: {}, output, ...extra };
}

describe("extractPresentedBuilds", () => {
  it("reads cards from structuredContent", () => {
    const found = extractPresentedBuilds([
      { id: "m1", role: "assistant", parts: [{ type: "text", text: "hi" }, presentPart(presentOutput())] }
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].cards).toHaveLength(1);
    expect(found[0].cards[0].label).toBe("Gaming build");
  });

  it("falls back to JSON.parse(content[0].text).cards", () => {
    const output = presentOutput({ structuredContent: undefined });
    delete (output as Record<string, unknown>).structuredContent;
    const found = extractPresentedBuilds([{ id: "m1", role: "assistant", parts: [presentPart(output)] }]);
    expect(found).toHaveLength(1);
    expect(found[0].cards[0].label).toBe("Gaming build");
  });

  it("never cards a failed present (presented === false)", () => {
    const output = presentOutput({
      structuredContent: { presented: false, builds: [], cards: [], issues: ["unknown label"] }
    });
    const found = extractPresentedBuilds([{ id: "m1", role: "assistant", parts: [presentPart(output)] }]);
    expect(found).toHaveLength(0);
  });

  it("ignores other tools, running calls, and malformed output", () => {
    const messages = [
      {
        id: "m1",
        role: "assistant",
        parts: [
          { type: "tool-validate_build", toolCallId: "v1", state: "output-available", output: { valid: true } },
          { type: "tool-present_build", toolCallId: "p1", state: "input-available", input: {} },
          { type: "tool-present_build", toolCallId: "p2", state: "output-available", output: { nope: true } },
          presentPart(presentOutput())
        ]
      }
    ];
    const found = extractPresentedBuilds(messages);
    expect(found).toHaveLength(1);
    expect(found[0].toolCallId).toBe("call-1");
  });
});

describe("hasPresentAttempt", () => {
  it("is true for any present_build part, even a failed one", () => {
    expect(hasPresentAttempt([{ role: "assistant", parts: [presentPart(presentOutput({ structuredContent: { presented: false } }))] }])).toBe(true);
    expect(hasPresentAttempt([{ role: "assistant", parts: [{ type: "text", text: "hi" }] }])).toBe(false);
  });
});
