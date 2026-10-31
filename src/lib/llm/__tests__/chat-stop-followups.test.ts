import { describe, expect, it } from "vitest";
import { stopAfterFollowups, hasFollowupsCall } from "../chat-engine";

const WHOLE = [{ category: "cpu" }, { category: "motherboard" }];

function validateSuccess(id: string) {
  return {
    toolCallId: id,
    toolName: "validate_build",
    output: { builds: { "Within budget": { valid: true, issues: [], snapshot: { components: WHOLE } } } }
  };
}

describe("stopAfterFollowups", () => {
  it("ends turn after suggest_followups when text reply path is done", () => {
    const steps = [
      { text: "Go with the 7800X3D.", toolCalls: [{ toolName: "suggest_followups", toolCallId: "s1" }], toolResults: [] }
    ];
    expect(hasFollowupsCall(steps)).toBe(true);
    expect(stopAfterFollowups({ steps })).toBe(true);
  });

  it("keeps going when no text reply has been written yet", () => {
    const steps = [
      { text: "  ", toolCalls: [{ toolName: "suggest_followups", toolCallId: "s1" }], toolResults: [] }
    ];
    expect(stopAfterFollowups({ steps })).toBe(false);
  });

  it("keeps going when another call in the same step still needs the model", () => {
    const steps = [
      {
        text: "Let me check prices.",
        toolCalls: [
          { toolName: "search_products", toolCallId: "q1" },
          { toolName: "suggest_followups", toolCallId: "s1" }
        ],
        toolResults: [{ toolCallId: "q1", toolName: "search_products", output: { results: [] } }]
      }
    ];
    expect(stopAfterFollowups({ steps })).toBe(false);
  });

  it("keeps going when suggest_followups was an earlier step, not the latest", () => {
    const steps = [
      { text: "Here you go.", toolCalls: [{ toolName: "suggest_followups", toolCallId: "s1" }], toolResults: [] },
      { toolCalls: [{ toolName: "search_products", toolCallId: "q1" }], toolResults: [] }
    ];
    expect(stopAfterFollowups({ steps })).toBe(false);
  });

  it("does not stop when validated but not presented (force-present wins)", () => {
    const steps = [
      { toolCalls: [{ toolName: "validate_build", toolCallId: "v1" }], toolResults: [validateSuccess("v1")] },
      { toolCalls: [{ toolName: "suggest_followups", toolCallId: "s1" }], toolResults: [] }
    ];
    expect(stopAfterFollowups({ steps } as never)).toBe(false);
  });

  it("does not stop without suggest_followups", () => {
    expect(stopAfterFollowups({ steps: [] })).toBe(false);
  });
});
