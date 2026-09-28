import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ModelMessage } from "ai";
import { streamChat } from "../chat-engine";
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
    expect(result).toEqual({ toolChoice: "required" });
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

  it("closes research without narrowing tools when nothing is validated late in the turn", async () => {
    const result = (await capturedPrepareStep!({ steps: [], stepNumber: 20, messages: [] })) as {
      activeTools?: string[];
      toolChoice?: unknown;
      instructions?: string;
    };
    // Search stays callable (no NoSuchToolError); the model must call a tool and is told why.
    expect(result.activeTools).toBeUndefined();
    expect(result.toolChoice).toBe("required");
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
