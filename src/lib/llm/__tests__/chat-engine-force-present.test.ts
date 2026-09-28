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

function validateSuccess(id: string) {
  return {
    toolCallId: id,
    toolName: "validate_build",
    output: {
      builds: {
        "Within budget": {
          valid: true,
          snapshot: { label: "Within budget", components: [] }
        }
      }
    }
  };
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
    await expect(
      capturedPrepareStep!({ steps: [], stepNumber: 20, messages: [] })
    ).resolves.toEqual({ activeTools: ["validate_build", "present_build"] });
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
