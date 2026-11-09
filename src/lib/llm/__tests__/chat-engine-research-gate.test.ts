import { describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import { forcePresentDirectives, gateResearchTools, isResearchClosed, remainingSearchNote, repeatedSearchMessage, researchClosedMessage, validateFirstMessage, validateNextNote } from "../chat-engine";

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
    await expect((gated.search_products.toModelOutput as ToModel)({ output: { results: [] } })).resolves.toEqual({
      type: "json",
      value: { trimmed: { results: [] } }
    });
  });

  it("tells the model to validate once every core category is searched and nothing is validated", async () => {
    const { tools } = fakeTools();
    let validated = false;
    const gated = gateResearchTools(tools, () => null, { validated: () => validated, stepsUsed: () => 7 });
    const search = (category: string) => (gated.search_products.execute as Exec)({ category }, {});
    const toModel = (output: unknown) => (gated.search_products.toModelOutput as ToModel)({ output });

    expect(await search("cpu")).toEqual({ results: [{ id: "p1" }] });
    // From the second core category on, the note names what's left to search in one step.
    expect(await search("motherboard")).toEqual({ results: [{ id: "p1" }], next_step: remainingSearchNote(["ram", "storage", "psu", "case"]) });
    for (const category of ["ram", "storage", "psu"]) await search(category);
    expect(remainingSearchNote(["case"])).toBe(
      "For a whole build, case is not searched yet: search it in your next step (one search_products call per category, all in the same step), then call validate_build."
    );
    const last = await search("Case");
    expect(last).toEqual({ results: [{ id: "p1" }], next_step: validateNextNote(8) });
    await expect(toModel(last)).resolves.toEqual({
      type: "json",
      value: { trimmed: { results: [{ id: "p1" }], next_step: validateNextNote(8) }, next_step: validateNextNote(8) }
    });

    validated = true;
    expect(await search("gpu")).toEqual({ results: [{ id: "p1" }] });
  });

  it("pauses search from step 12 until validate_build is called once, then reopens it", async () => {
    const { tools, search } = fakeTools();
    let called = false;
    let stepsUsed = 5;
    const gated = gateResearchTools(tools, () => null, { validated: () => false, validateCalled: () => called, stepsUsed: () => stepsUsed });
    const run = (category: string) => (gated.search_products.execute as Exec)({ category }, {});
    for (const category of ["cpu", "motherboard", "ram", "storage", "psu", "case"]) await run(category);
    stepsUsed = 10;
    expect(await run("gpu")).toMatchObject({ results: [{ id: "p1" }] });
    stepsUsed = 11;
    const paused = await run("gpu");
    expect(paused).toEqual({ results: [], search_closed: true, message: validateFirstMessage(12) });
    await expect((gated.search_products.toModelOutput as ToModel)({ output: paused })).resolves.toEqual({ type: "text", value: validateFirstMessage(12) });
    expect(search).toHaveBeenCalledTimes(7);
    called = true;
    expect(await run("cooler")).toMatchObject({ results: [{ id: "p1" }] });
  });

  it("forces a validate_build call at step 12 once every core category is searched, until it is called", () => {
    const search = (category: string) => ({ toolCalls: [{ toolName: "search_products", toolCallId: category, input: { category } }] });
    const core = ["cpu", "motherboard", "ram", "storage", "psu", "case"].map(search);
    const forced = { activeTools: ["validate_build"], toolChoice: { type: "tool", toolName: "validate_build" } };
    const required = { toolChoice: "required" };
    expect(forcePresentDirectives(core, 10)).toEqual(required);
    expect(forcePresentDirectives(core, 11)).toEqual(forced);
    expect(forcePresentDirectives(core.slice(1), 11)).toEqual({});
    // Forced once: a call that leaves out parts gets the missing-parts note, not another forced call.
    const partial = [...core, { toolCalls: [{ toolName: "validate_build", toolCallId: "v" }] }];
    expect(forcePresentDirectives(partial, 12)).toEqual(required);
    // Not when the turn never searched every core category.
    expect(forcePresentDirectives([{ toolCalls: [{ toolName: "validate_build", toolCallId: "v" }] }], 1)).toEqual({});
  });

  it("makes a building turn call a tool each step until it presents, and leaves other turns free", () => {
    const call = (toolName: string, input: unknown = {}) => ({ toolCalls: [{ toolName, toolCallId: toolName, input }] });
    expect(forcePresentDirectives([], 0)).toEqual({});
    // A question turn that looked one thing up can still answer in text.
    expect(forcePresentDirectives([call("search_products", { category: "ram" })], 1)).toEqual({});
  });

  it("forces validate_build before step 12 once every core category is searched and a search repeats", () => {
    const search = (category: string) => ({ toolCalls: [{ toolName: "search_products", toolCallId: category, input: { category, limit: 5 } }] });
    const core = ["cpu", "motherboard", "ram", "storage", "psu", "case"].map(search);
    expect(forcePresentDirectives(core, 2)).toEqual({ toolChoice: "required" });
    const forced = { activeTools: ["validate_build"], toolChoice: { type: "tool", toolName: "validate_build" } };
    // The same cpu search again (limit aside) is a repeat.
    const repeat = { toolCalls: [{ toolName: "search_products", toolCallId: "again", input: { limit: 12, category: "cpu" } }] };
    expect(forcePresentDirectives([...core, repeat], 2)).toEqual(forced);
    // A repeat before every core category is searched doesn't force.
    expect(forcePresentDirectives([...core.slice(1), search("ram"), search("ram")], 3)).toEqual({});
    expect(forcePresentDirectives(core.slice(1), 11)).toEqual({});
  });

  it("also tells the model to validate from step 10, whatever it has searched", async () => {
    const { tools } = fakeTools();
    let stepsUsed = 8;
    const gated = gateResearchTools(tools, () => null, { validated: () => false, stepsUsed: () => stepsUsed });
    expect(await (gated.search_products.execute as Exec)({ category: "gpu" }, {})).toEqual({ results: [{ id: "p1" }] });
    stepsUsed = 9;
    expect(await (gated.search_products.execute as Exec)({ category: "cooler" }, {})).toEqual({ results: [{ id: "p1" }], next_step: validateNextNote(10) });
  });

  it("answers a repeat of an earlier research call with a pointer instead of running it", async () => {
    const { tools, search } = fakeTools();
    let stepsUsed = 3;
    const gated = gateResearchTools(tools, () => null, { validated: () => false, stepsUsed: () => stepsUsed });
    const run = (input: unknown) => (gated.search_products.execute as Exec)(input, {});
    await run({ category: "cpu", term: "Ryzen 5 5600", limit: 10 });
    stepsUsed = 6;
    // Same filters in another key order and limit: a repeat of step 4.
    const repeat = await run({ limit: 5, term: "Ryzen 5 5600", category: "cpu" });
    expect(repeat).toEqual({ results: [], search_closed: true, message: repeatedSearchMessage(4) });
    expect(repeatedSearchMessage(6, ["acb6ac64b6 AMD Ryzen 5 5600 9800"])).toBe(
      "Same call as step 6. Its top results: acb6ac64b6 AMD Ryzen 5 5600 9800. Pick from these or the rest of its results earlier in this turn, or change the filters."
    );
    // The earlier call's top rows come back with the repeat.
    search.mockResolvedValueOnce({ results: [{ id: "acb6ac64b6aaaa", name: "AMD Ryzen 5 5600", price: 9800 }] } as never);
    await run({ category: "cpu", term: "5600" });
    expect(await run({ category: "cpu", term: "5600" })).toMatchObject({ message: repeatedSearchMessage(7, ["acb6ac64b6 AMD Ryzen 5 5600 9800"]) });
    await expect((gated.search_products.toModelOutput as ToModel)({ output: repeat })).resolves.toEqual({ type: "text", value: repeatedSearchMessage(4) });
    // A changed filter runs.
    await run({ category: "cpu", term: "Ryzen 5 5600", price_max: 15000 });
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("runs the retry of a research call that failed", async () => {
    const { tools, search } = fakeTools();
    const gated = gateResearchTools(tools, () => null, { validated: () => false, stepsUsed: () => 3 });
    const run = (input: unknown) => (gated.search_products.execute as Exec)(input, {});
    search.mockRejectedValueOnce(new Error("database is locked"));
    await expect(run({ category: "cpu" })).rejects.toThrow("database is locked");
    search.mockResolvedValueOnce({ results: [], error: "catalog unavailable" } as never);
    await run({ category: "cpu" });
    expect(await run({ category: "cpu" })).toEqual({ results: [{ id: "p1" }] });
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("returns a normal 'search is closed' result while closed, without running the search", async () => {
    const { tools, search, validate } = fakeTools();
    const gated = gateResearchTools(tools, () => 3);
    const output = await (gated.search_products.execute as Exec)("gpu", {});
    expect(search).not.toHaveBeenCalled();
    expect(output).toMatchObject({ results: [], search_closed: true, message: researchClosedMessage(3) });
    await expect((gated.search_products.toModelOutput as ToModel)({ output })).resolves.toEqual({
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
