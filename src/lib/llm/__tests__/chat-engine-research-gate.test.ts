import { describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import { gateResearchTools, isResearchClosed, researchClosedMessage } from "../chat-engine";

const WHOLE_BUILD = [{ category: "cpu" }, { category: "motherboard" }];
const validatedSteps = [
  {
    toolCalls: [{ toolCallId: "v1", toolName: "validate_build" }],
    toolResults: [
      { toolCallId: "v1", toolName: "validate_build", output: { valid: true, issues: [], snapshot: { components: WHOLE_BUILD } } }
    ]
  }
];

function fakeTools() {
  const search = vi.fn(async () => ({ results: [{ id: "p1" }] }));
  const validate = vi.fn(async () => ({ valid: true }));
  const tools = {
    search_products: {
      inputSchema: {},
      execute: search,
      toModelOutput: ({ output }: { output: unknown }) => ({ type: "json", value: { trimmed: output } })
    },
    validate_build: { inputSchema: {}, execute: validate }
  } as unknown as ToolSet;
  return { tools, search, validate };
}

type Exec = (input: unknown, options: unknown) => Promise<unknown>;
type ToModel = (args: { input?: unknown; output: unknown }) => unknown;

describe("late-turn research gate", () => {
  it("closes only from step 20 with nothing validated or presented", () => {
    expect(isResearchClosed([], 19)).toBe(false);
    expect(isResearchClosed([], 20)).toBe(true);
    expect(isResearchClosed(validatedSteps, 20)).toBe(false);
  });

  it("passes research calls through while open", async () => {
    const { tools, search } = fakeTools();
    const gated = gateResearchTools(tools, () => null);
    await expect((gated.search_products.execute as Exec)({ category: "gpu" }, {})).resolves.toEqual({ results: [{ id: "p1" }] });
    expect(search).toHaveBeenCalledOnce();
    expect((gated.search_products.toModelOutput as ToModel)({ output: { results: [] } })).toEqual({
      type: "json",
      value: { trimmed: { results: [] } }
    });
  });

  it("returns a normal 'search is closed' result while closed, without running the search", async () => {
    const { tools, search, validate } = fakeTools();
    const gated = gateResearchTools(tools, () => 3);
    const output = await (gated.search_products.execute as Exec)("gpu", {});
    expect(search).not.toHaveBeenCalled();
    expect(output).toMatchObject({ results: [], search_closed: true, message: researchClosedMessage(3) });
    expect((gated.search_products.toModelOutput as ToModel)({ output })).toEqual({
      type: "text",
      value: "Search is closed for this turn (3 steps left). Call validate_build now with the best parts you've already found, then present_build a valid build."
    });
    // validate_build is never gated.
    await (gated.validate_build.execute as Exec)({}, {});
    expect(validate).toHaveBeenCalledOnce();
  });
});

describe("continuationMessageId", () => {
  it("mirrors the SDK rule: last assistant id, else undefined", async () => {
    const { continuationMessageId } = await import("../chat-engine");
    expect(continuationMessageId([{ id: "u1", role: "user" }, { id: "a1", role: "assistant" }])).toBe("a1");
    expect(continuationMessageId([{ id: "a1", role: "assistant" }, { id: "u1", role: "user" }])).toBeUndefined();
    expect(continuationMessageId([{ role: "assistant" }])).toBeUndefined();
    expect(continuationMessageId([])).toBeUndefined();
  });
});
