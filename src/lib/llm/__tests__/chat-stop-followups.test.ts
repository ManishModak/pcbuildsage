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
      { toolCalls: [{ toolName: "suggest_followups", toolCallId: "s1" }], toolResults: [] }
    ];
    expect(hasFollowupsCall(steps)).toBe(true);
    expect(stopAfterFollowups({ steps })).toBe(true);
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
