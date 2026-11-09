import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ModelMessage } from "ai";
import { streamChat } from "../chat-engine";
import { FAR_OVER_ALREADY_SHOWN, FOLLOWUPS_HELD_MESSAGE, MAX_STEPS, buildPending, farOverBudgetNote, forcePresentDirectives, stopAfterFollowups, holdFollowupsUntilPresented, pushForNearBudgetPresent } from "../turn-policy";
import * as clientModule from "../client";
import type { AppConfig } from "@/types";

vi.mock("../client", () => ({
  streamTextWithFallback: vi.fn(),
  generateTextWithFallback: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  appendChatLog: vi.fn().mockResolvedValue(undefined)
}));

type PrepareStepFn = (options: {
  steps: never[];
  stepNumber?: number;
  messages: ModelMessage[];
}) => Promise<unknown>;

const config: AppConfig = {
  dbPath: ":memory:",
  countryCode: "US",
  currency: "USD",
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

function validateCall(id: string) {
  return { toolCallId: id, toolName: "validate_build", input: {} };
}

const WHOLE_BUILD = [{ category: "cpu" }, { category: "motherboard" }, { category: "ram" }];

function validateResult(id: string, build: Record<string, unknown>) {
  return { toolCallId: id, toolName: "validate_build", output: { builds: { "Within budget": build } } };
}

function validateSuccess(id: string) {
  return validateResult(id, { valid: true, issues: [], snapshot: { label: "Within budget", components: WHOLE_BUILD } });
}

function presentCall(id: string) {
  return { toolCallId: id, toolName: "present_build", input: {} };
}

describe("chat-engine force-present directives", () => {
  let capturedPrepareStep: PrepareStepFn | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedPrepareStep = undefined;
    vi.mocked(clientModule.streamTextWithFallback).mockImplementation((options: unknown) => {
      capturedPrepareStep = (options as { prepareStep: PrepareStepFn }).prepareStep;
      return {} as never;
    });
    await streamChat(config, [{ role: "user", content: "Gaming PC for 1080p" }]);
    expect(capturedPrepareStep).toBeDefined();
  });

  it("behaves as before when nothing is validated yet", async () => {
    const result = await capturedPrepareStep!({ steps: [], stepNumber: 3, messages: [] });
    expect(result).toEqual({});
  });

  it("requires a tool call once validation succeeds so the turn cannot end on text", async () => {
    const steps = [
      { toolCalls: [validateCall("v1")], toolResults: [validateSuccess("v1")] }
    ] as never[];
    const result = await capturedPrepareStep!({ steps, stepNumber: 5, messages: [] });
    // The tool list stays as it is: changing it mid-turn makes a local server re-read the prompt.
    expect(result).toEqual({ toolChoice: "required" });
  });

  it("forces present_build after a validate_build call that repeats an earlier one", async () => {
    const same = { builds: [{ label: "Within budget", parts: { cpu: { product_id: "abcdef1234" } } }] };
    const steps = [
      { toolCalls: [{ ...validateCall("v1"), input: same }], toolResults: [validateSuccess("v1")] },
      { toolCalls: [{ ...validateCall("v2"), input: { builds: [{ label: "Other", parts: {} }] } }], toolResults: [validateSuccess("v2")] }
    ] as never[];
    expect(((await capturedPrepareStep!({ steps, stepNumber: 9, messages: [] })) as { toolChoice?: unknown }).toolChoice).toBe("required");
    const repeated = [...steps, { toolCalls: [{ ...validateCall("v3"), input: same }], toolResults: [validateSuccess("v3")] }] as never[];
    expect(await capturedPrepareStep!({ steps: repeated, stepNumber: 10, messages: [] })).toEqual({
      activeTools: ["present_build"],
      toolChoice: { type: "tool", toolName: "present_build" }
    });
    // Far over the budget, a repeat is left to be fixed rather than presented (Lightning r32 office, 72,425 for 35,000).
    const over = validateResult("v3", {
      valid: true,
      issues: [],
      budget: { target: 35000, total: 72425, over_by: 37425, under_by: 0 },
      snapshot: { label: "Within budget", components: WHOLE_BUILD }
    });
    const repeatedOver = [...steps, { toolCalls: [{ ...validateCall("v3"), input: same }], toolResults: [over] }] as never[];
    expect(((await capturedPrepareStep!({ steps: repeatedOver, stepNumber: 10, messages: [] })) as { toolChoice?: unknown }).toolChoice).toBe("required");
  });

  it("does not count a failed validate_build execution as success", async () => {
    const steps = [
      {
        toolCalls: [validateCall("v1")],
        toolResults: [{ toolCallId: "v1", toolName: "validate_build", error: new Error("boom") }]
      }
    ] as never[];
    const result = await capturedPrepareStep!({ steps, stepNumber: 5, messages: [] });
    expect(result).toEqual({});
  });

  it("leaves the model free to answer when the validation is invalid or only a spot check", async () => {
    const cases = [
      // Incompatible build: the model should explain, not present it.
      validateResult("v1", { valid: false, issues: [{ severity: "blocking" }], snapshot: { components: WHOLE_BUILD } }),
      validateResult("v1", { valid: true, issues: [{ severity: "blocking" }], snapshot: { components: WHOLE_BUILD } }),
      // "Will this GPU fit my case?" is a compatibility question, not a build.
      validateResult("v1", { valid: true, issues: [], snapshot: { components: [{ category: "gpu" }, { category: "case" }] } })
    ];
    for (const result of cases) {
      const steps = [{ toolCalls: [validateCall("v1")], toolResults: [result] }] as never[];
      await expect(capturedPrepareStep!({ steps, stepNumber: 5, messages: [] })).resolves.toEqual({});
    }
  });

  it("returns to auto after present_build so the model can explain", async () => {
    const steps = [
      { toolCalls: [validateCall("v1")], toolResults: [validateSuccess("v1")] },
      { toolCalls: [presentCall("p1")], toolResults: [{ toolCallId: "p1", toolName: "present_build", output: { presented: true } }] }
    ] as never[];
    const result = await capturedPrepareStep!({ steps, stepNumber: 6, messages: [] });
    expect(result).toEqual({});
  });

  it("restricts late-turn steps to validation and presentation tools", async () => {
    const validated = [
      { toolCalls: [validateCall("v1")], toolResults: [validateSuccess("v1")] }
    ] as never[];
    await expect(
      capturedPrepareStep!({ steps: validated, stepNumber: 20, messages: [] })
    ).resolves.toEqual({
      activeTools: ["validate_build", "present_build"],
      toolChoice: "required"
    });
  });

  it("closes research and forces validate_build when nothing is validated late in the turn", async () => {
    const result = (await capturedPrepareStep!({ steps: [], stepNumber: 20, messages: [] })) as {
      activeTools?: string[];
      toolChoice?: unknown;
      instructions?: string;
    };
    // present_build can't succeed unvalidated and search is closed, so validate_build is the one call.
    expect(result.activeTools).toEqual(["validate_build"]);
    expect(result.toolChoice).toEqual({ type: "tool", toolName: "validate_build" });
    expect(result.instructions).toContain("research is closed (4 steps left)");
    expect(result.instructions).toContain("validate_build");
  });

  it("allows text only on the final step when nothing was validated, so the turn cannot end empty", async () => {
    const result = (await capturedPrepareStep!({ steps: [], stepNumber: 24, messages: [] })) as {
      toolChoice?: unknown;
      instructions?: string;
    };
    expect(result.toolChoice).toBe("none");
    expect(result.instructions).toContain("Answer now in text");
  });

  it("forces present_build by name on the final step when validation succeeded but nothing is presented", async () => {
    const steps = [
      { toolCalls: [validateCall("v1")], toolResults: [validateSuccess("v1")] }
    ] as never[];
    const result = await capturedPrepareStep!({ steps, stepNumber: 24, messages: [] });
    expect(result).toEqual({
      activeTools: ["present_build"],
      toolChoice: { type: "tool", toolName: "present_build" }
    });
  });
});

describe("suggest_followups while a validated build waits", () => {
  it("refuses while held and runs once presented, keeping the tool list", async () => {
    let held = true;
    const execute = vi.fn().mockResolvedValue({ prompts: ["Add a GPU later"] });
    const tools = holdFollowupsUntilPresented({ suggest_followups: { execute } } as never, () => held);
    const run = (tools.suggest_followups as { execute: (input: unknown, options: unknown) => Promise<unknown> }).execute;
    expect(await run({ prompts: ["Present these as build cards"] }, {})).toEqual({ prompts: [], error: FOLLOWUPS_HELD_MESSAGE });
    expect(execute).not.toHaveBeenCalled();
    held = false;
    expect(await run({ prompts: ["Add a GPU later"] }, {})).toEqual({ prompts: ["Add a GPU later"] });
    expect(Object.keys(tools)).toEqual(["suggest_followups"]);
  });
});

describe("pushForNearBudgetPresent", () => {
  const build = (label: string, target: number | undefined, overBy: number, ids = [label]) => ({
    label,
    product_ids: ids,
    validation: { valid: true, snapshot: { currency: "INR" }, ...(target === undefined ? {} : { budget: { target, total: target + overBy, over_by: overBy, under_by: 0 } }) }
  });
  const presentingTool = (step = 21) => {
    let current = step;
    let builds: unknown[] = [];
    const execute = vi.fn(async () => ({ presented: true, buildCount: builds.length, builds }));
    const tools = pushForNearBudgetPresent({ present_build: { execute } } as never, () => current);
    const run = (tools.present_build as { execute: (input: unknown, options: unknown) => Promise<unknown> }).execute;
    return { present: (...next: unknown[]) => { builds = next; return run({ builds: [] }, {}); }, setStep: (n: number) => { current = n; } };
  };

  it("shows builds that are all far over the budget, flagged, and tells the model to find one within it", async () => {
    const { present } = presentingTool();
    const far = [build("Performance", 70000, 164629), build("Balanced", 70000, 20000)];
    expect(await present(...far)).toEqual({
      presented: true,
      buildCount: 2,
      builds: far,
      far_over_budget: true,
      next_step: farOverBudgetNote("Balanced", { target: 70000, over_by: 20000 }, "INR")
    });
    expect(farOverBudgetNote("Balanced", { target: 70000, over_by: 20000 }, "INR")).toContain("at or under ₹73,500");
    // The limit rounds down, so a build at it stays within 5% ($999 * 1.05 = $1,048.95).
    expect(farOverBudgetNote("A", { target: 999, over_by: 500 }, "USD")).toContain("at or under $1,048");
  });

  it("leaves a call alone when one build is within 5% of the budget, no budget was given, or it is the final step", async () => {
    expect(await presentingTool().present(build("Performance", 70000, 164629), build("Within budget", 70000, 3000))).not.toHaveProperty("far_over_budget");
    expect(await presentingTool().present(build("Any", undefined, 0))).not.toHaveProperty("far_over_budget");
    expect(await presentingTool(MAX_STEPS - 1).present(build("Performance", 70000, 164629))).not.toHaveProperty("far_over_budget");
  });

  it("refuses the same far-over builds again as already shown, but shows different ones", async () => {
    const { present } = presentingTool();
    await present(build("Performance", 70000, 164629, ["a", "b"]));
    expect(await present(build("Performance again", 70000, 164629, ["b", "a"]))).toEqual({ presented: false, error: FAR_OVER_ALREADY_SHOWN });
    expect(await present(build("Cheaper", 70000, 9000, ["a", "c"]))).toMatchObject({ presented: true, far_over_budget: true });
  });

  it("keeps the turn working after a far-over presentation, forcing a present on the final step", async () => {
    const steps = [
      { toolCalls: [validateCall("v1")], toolResults: [validateSuccess("v1")] },
      { toolCalls: [presentCall("p1")], toolResults: [{ toolCallId: "p1", toolName: "present_build", output: { presented: true, far_over_budget: true } }] }
    ] as never[];
    expect(forcePresentDirectives(steps, 21)).toEqual({
      activeTools: ["validate_build", "present_build"],
      toolChoice: "required"
    });
    expect(buildPending(steps)).toBe(true);
    // The final step presents, so a cheaper build validated since gets shown.
    expect(forcePresentDirectives(steps, MAX_STEPS - 1)).toEqual({ activeTools: ["present_build"], toolChoice: { type: "tool", toolName: "present_build" } });
    // A build validated only inside present_build still keeps the turn forced.
    const presentedOnly = [steps[1]] as never[];
    expect(forcePresentDirectives(presentedOnly, 6)).toEqual({ toolChoice: "required" });
    // Follow-ups don't end the turn before a build that settles it.
    expect(stopAfterFollowups({ steps: [...steps, { text: "Here it is.", toolCalls: [{ toolName: "suggest_followups", toolCallId: "f" }], toolResults: [] }] as never[] })).toBe(false);
    // A later build within the budget settles it.
    const settled = [...steps, { toolCalls: [presentCall("p2")], toolResults: [{ toolCallId: "p2", toolName: "present_build", output: { presented: true } }] }] as never[];
    expect(forcePresentDirectives(settled, 22)).toEqual({});
    expect(buildPending(settled)).toBe(false);
  });
});
