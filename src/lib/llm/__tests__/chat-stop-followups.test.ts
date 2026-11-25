import { describe, expect, it } from "vitest";
import { stopAfterFollowups, hasFollowupsCall } from "../turn-policy";

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

  it("keeps a build turn going before its first validation, once every core category is searched", () => {
    const searches = ["cpu", "motherboard", "ram", "storage", "psu", "case"].map((category, i) => ({ toolName: "search_products", toolCallId: `q${i}`, input: { category } }));
    const steps = [
      { text: "", toolCalls: searches, toolResults: [] },
      { text: "Here is my plan.", toolCalls: [{ toolName: "suggest_followups", toolCallId: "s1" }], toolResults: [] }
    ];
    expect(stopAfterFollowups({ steps })).toBe(false);
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

  it("does not stop after present_build with followups when assistant text has not been written yet", () => {
    const steps = [
      { toolCalls: [{ toolName: "validate_build", toolCallId: "v1" }], toolResults: [validateSuccess("v1")] },
      {
        text: "",
        toolCalls: [{ toolName: "present_build", toolCallId: "p1", input: { builds: [{ label: "Within budget" }], followups: ["Add a GPU later"] } }],
        toolResults: [{ toolCallId: "p1", toolName: "present_build", output: { presented: true, followups: ["Add a GPU later"] } }]
      }
    ];
    expect(hasFollowupsCall(steps as never)).toBe(true);
    expect(stopAfterFollowups({ steps: steps as never })).toBe(false);
  });

  it("stops cleanly when assistant text accompanies a successful present_build with followups", () => {
    const steps = [
      { toolCalls: [{ toolName: "validate_build", toolCallId: "v1" }], toolResults: [validateSuccess("v1")] },
      {
        text: "Here is your within-budget build.",
        toolCalls: [{ toolName: "present_build", toolCallId: "p1", input: { builds: [{ label: "Within budget" }], followups: ["Add a GPU later"] } }],
        toolResults: [{ toolCallId: "p1", toolName: "present_build", output: { presented: true, followups: ["Add a GPU later"] } }]
      }
    ];
    expect(stopAfterFollowups({ steps: steps as never })).toBe(true);
  });

  it("does not stop when present_build has no followups or was refused", () => {
    const noFollowups = [
      { toolCalls: [{ toolName: "validate_build", toolCallId: "v1" }], toolResults: [validateSuccess("v1")] },
      {
        text: "Here is your build.",
        toolCalls: [{ toolName: "present_build", toolCallId: "p1", input: { builds: [{ label: "Within budget" }] } }],
        toolResults: [{ toolCallId: "p1", toolName: "present_build", output: { presented: true } }]
      }
    ];
    expect(hasFollowupsCall(noFollowups as never)).toBe(false);
    expect(stopAfterFollowups({ steps: noFollowups as never })).toBe(false);

    const refused = [
      { toolCalls: [{ toolName: "validate_build", toolCallId: "v1" }], toolResults: [validateSuccess("v1")] },
      {
        text: "Here is your build.",
        toolCalls: [{ toolName: "present_build", toolCallId: "p1", input: { builds: [{ label: "Typo" }], followups: ["Add a GPU later"] } }],
        toolResults: [{ toolCallId: "p1", toolName: "present_build", output: { presented: false, error: "missing" } }]
      }
    ];
    expect(stopAfterFollowups({ steps: refused as never })).toBe(false);
  });

  it("does not stop on earlier progress text or when present_build reports partial refusal or renamed labels", () => {
    const progressOnly = [
      { text: "I'll check prices first.", toolCalls: [{ toolName: "search_products", toolCallId: "q1" }], toolResults: [] },
      { toolCalls: [{ toolName: "validate_build", toolCallId: "v1" }], toolResults: [validateSuccess("v1")] },
      {
        text: "",
        toolCalls: [{ toolName: "present_build", toolCallId: "p1", input: { builds: [{ label: "Within budget" }], followups: ["Add a GPU later"] } }],
        toolResults: [{ toolCallId: "p1", toolName: "present_build", output: { presented: true, followups: ["Add a GPU later"] } }]
      }
    ];
    expect(stopAfterFollowups({ steps: progressOnly as never })).toBe(false);

    const partialRefusal = [
      { toolCalls: [{ toolName: "validate_build", toolCallId: "v1" }], toolResults: [validateSuccess("v1")] },
      {
        text: "Here are both builds.",
        toolCalls: [{ toolName: "present_build", toolCallId: "p1", input: { builds: [{ label: "Within budget" }, { label: "Bad" }], followups: ["Add a GPU later"] } }],
        toolResults: [{ toolCallId: "p1", toolName: "present_build", output: { presented: true, followups: ["Add a GPU later"], not_presented: [{ label: "Bad", error: "blocking" }] } }]
      }
    ];
    expect(stopAfterFollowups({ steps: partialRefusal as never })).toBe(false);

    const renamedLabel = [
      { toolCalls: [{ toolName: "validate_build", toolCallId: "v1" }], toolResults: [validateSuccess("v1")] },
      {
        text: "Here is your within-budget build.",
        toolCalls: [{ toolName: "present_build", toolCallId: "p1", input: { builds: [{ label: "Within budget" }], followups: ["Add a GPU later"] } }],
        toolResults: [{ toolCallId: "p1", toolName: "present_build", output: { presented: true, followups: ["Add a GPU later"], label_note: "Shown under an honest label" } }]
      }
    ];
    expect(stopAfterFollowups({ steps: renamedLabel as never })).toBe(false);

    const textlessLegacyFollowups = [
      { text: "Let me check prices first.", toolCalls: [{ toolName: "search_products", toolCallId: "q1" }], toolResults: [] },
      { text: "", toolCalls: [{ toolName: "suggest_followups", toolCallId: "s1" }], toolResults: [] }
    ];
    expect(stopAfterFollowups({ steps: textlessLegacyFollowups as never })).toBe(false);
  });
});
