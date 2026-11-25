import { describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import { forcePresentDirectives, gateResearchTools, isResearchClosed, remainingSearchNote, repeatedSearchMessage, researchClosedMessage, validateFirstMessage, validateNextNote } from "../turn-policy";

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
    const forced = { toolChoice: { type: "tool", toolName: "validate_build" } };
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

  it("forces validate_build before step 12 on a repeat with equal/smaller limit, while allowing a wider limit", () => {
    const search = (category: string) => ({ toolCalls: [{ toolName: "search_products", toolCallId: category, input: { category, limit: 5 } }] });
    const core = ["cpu", "motherboard", "ram", "storage", "psu", "case"].map(search);
    expect(forcePresentDirectives(core, 2)).toEqual({ toolChoice: "required" });
    const forced = { toolChoice: { type: "tool", toolName: "validate_build" } };
    // Widening limit (5 -> 12) fetches more candidates and is NOT a repeat.
    const widened = { toolCalls: [{ toolName: "search_products", toolCallId: "wider", input: { limit: 12, category: "cpu" } }] };
    expect(forcePresentDirectives([...core, widened], 2)).toEqual({ toolChoice: "required" });
    // Same-or-smaller limit (5 -> 5 or 5 -> 3) IS a repeat and forces validate_build without changing activeTools.
    const repeat = { toolCalls: [{ toolName: "search_products", toolCallId: "again", input: { limit: 3, category: "cpu" } }] };
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
    expect(repeat).toEqual({ results: [], search_closed: true, repeated: true, message: repeatedSearchMessage(4) });
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

  it("says a repeated search found nothing the first time, instead of offering rows to pick from", async () => {
    const { tools, search } = fakeTools();
    const gated = gateResearchTools(tools, () => null, { validated: () => false, stepsUsed: () => 3 });
    const run = (input: unknown) => (gated.search_products.execute as Exec)(input, {});
    search.mockResolvedValueOnce({ results: [] } as never);
    await run({ category: "motherboard", socket: "AM4", form_factor: "Mini-ITX" });
    expect(await run({ category: "motherboard", socket: "AM4", form_factor: "Mini-ITX" })).toMatchObject({
      message: "Same call as step 4, which found nothing, so it would find nothing again. Drop or change a filter (term, socket, form_factor, price) and search again."
    });
  });

  it("points an identical call in the same step at the first one while it is still running", async () => {
    const { tools, search } = fakeTools();
    const gated = gateResearchTools(tools, () => null, { validated: () => false, stepsUsed: () => 3 });
    const run = (input: unknown) => (gated.search_products.execute as Exec)(input, {});
    let finish!: (value: unknown) => void;
    search.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }) as never);
    const first = run({ category: "motherboard", form_factor: "Mini-ITX" });
    const duplicate = await run({ category: "motherboard", form_factor: "Mini-ITX" });
    finish({ results: [] });
    await first;
    expect(duplicate).toMatchObject({ message: "Same call as another one in this step: use that call's result." });
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

  it("tracks all categories and deduplicates repeated sub-queries in batch search_products without blocking new ones", async () => {
    const batchSearch = vi.fn(async (input: { queries?: Array<{ category?: string; price_max?: number }> }) => ({
      batch: true,
      searches: (input.queries ?? []).map((q, i) => ({
        label: q.category ?? `search_${i + 1}`,
        ...(q.category ? { category: q.category } : {}),
        results: [{ id: `${q.category ?? "x"}-1234567890`, name: `${q.category} part`, price: 1000 }]
      }))
    }));
    const tools = {
      search_products: { inputSchema: {}, execute: batchSearch },
      validate_build: { inputSchema: {}, execute: vi.fn(async () => ({ valid: true })) }
    } as unknown as ToolSet;

    let validated = false;
    let validateCalled = false;
    let stepsUsed = 0;
    const gated = gateResearchTools(tools, () => null, {
      validated: () => validated,
      validateCalled: () => validateCalled,
      stepsUsed: () => stepsUsed
    });
    const run = (input: unknown) => (gated.search_products.execute as Exec)(input, {});

    // Step 1: 6-category batch immediately covers every core category and triggers validateNextNote.
    const first = (await run({
      queries: [
        { category: "cpu" },
        { category: "motherboard" },
        { category: "ram" },
        { category: "storage" },
        { category: "psu" },
        { category: "case" }
      ]
    })) as { batch: boolean; searches: Array<{ category?: string }>; next_step?: string };
    expect(first.batch).toBe(true);
    expect(first.searches).toHaveLength(6);
    expect(first.next_step).toBe(validateNextNote(1));
    expect(batchSearch).toHaveBeenCalledTimes(1);

    // Step 2: a batch mixing a repeated { category: "cpu" } and a new { category: "gpu" } only runs gpu!
    stepsUsed = 1;
    const mixed = (await run({
      queries: [{ category: "cpu", limit: 4 }, { category: "gpu", price_max: 35000 }]
    })) as { batch: boolean; searches: Array<{ search_closed?: boolean; message?: string; results: Array<{ id: string }> }> };
    expect(batchSearch).toHaveBeenCalledTimes(2);
    expect(batchSearch.mock.calls[1][0]).toEqual({ queries: [{ category: "gpu", price_max: 35000 }] });
    expect(mixed.searches[0].search_closed).toBe(true);
    expect(mixed.searches[0].message).toContain("Same call as step 1");
    expect(mixed.searches[1].results[0].id).toBe("gpu-1234567890");

    // Step 3: all-repeat batch skips calling underlying execute altogether.
    stepsUsed = 2;
    const allRepeat = (await run({ queries: [{ category: "cpu" }, { category: "gpu", price_max: 35000 }] })) as {
      search_closed?: boolean;
      message?: string;
    };
    expect(batchSearch).toHaveBeenCalledTimes(2);
    expect(allRepeat.search_closed).toBe(true);
    expect(allRepeat.message).toContain("Same call as step 1");

    // Step 12 with nothing validated pauses batch search via mustValidateFirst.
    stepsUsed = 11;
    const paused = (await run({ queries: [{ category: "cooler" }] })) as { search_closed?: boolean; message?: string };
    expect(paused).toEqual({ results: [], search_closed: true, message: validateFirstMessage(12) });
    expect(batchSearch).toHaveBeenCalledTimes(2);

    // Closed late-turn research blocks batch search identically to single searches.
    validated = false;
    validateCalled = true;
    const closedGated = gateResearchTools(tools, () => 2);
    expect(await (closedGated.search_products.execute as Exec)({ queries: [{ category: "cooler" }] }, {})).toEqual({
      results: [],
      search_closed: true,
      message: researchClosedMessage(2)
    });
  });

  it("recognizes a 6-category batch search in forcePresentDirectives without mutating activeTools", () => {
    const batch = {
      toolCalls: [
        {
          toolName: "search_products",
          toolCallId: "b1",
          input: {
            queries: [
              { category: "cpu" },
              { category: "motherboard" },
              { category: "ram" },
              { category: "storage" },
              { category: "psu" },
              { category: "case" }
            ]
          }
        }
      ]
    };
    expect(forcePresentDirectives([batch], 1)).toEqual({ toolChoice: "required" });
    expect(forcePresentDirectives([batch], 11)).toEqual({
      toolChoice: { type: "tool", toolName: "validate_build" }
    });
  });

  it("does not count truncated (9th) or rejected mixed batch queries toward core category coverage", () => {
    const truncated = {
      toolCalls: [
        {
          toolName: "search_products",
          toolCallId: "b-trunc",
          input: {
            queries: [
              { category: "cpu" },
              { category: "cpu" },
              { category: "motherboard" },
              { category: "ram" },
              { category: "storage" },
              { category: "psu" },
              { category: "gpu" },
              { category: "cooler" },
              { category: "case" }
            ]
          }
        }
      ]
    };
    // `case` was 9th (never executed), so only 5 core categories ran and validate_build must NOT be forced.
    expect(forcePresentDirectives([truncated], 2)).toEqual({});

    const rejectedMixed = {
      toolCalls: [
        {
          toolName: "search_products",
          toolCallId: "b-mixed",
          input: {
            category: "cpu",
            queries: [
              { category: "cpu" },
              { category: "motherboard" },
              { category: "ram" },
              { category: "storage" },
              { category: "psu" },
              { category: "case" }
            ]
          }
        }
      ],
      toolResults: [
        { toolCallId: "b-mixed", toolName: "search_products", output: { batch: true, searches: [], error: "Cannot combine" } }
      ]
    };
    expect(forcePresentDirectives([rejectedMixed], 2)).toEqual({});
  });

  it("deduplicates batch calls even with a harmless unknown top-level field, and allows widening limit after a narrower search", async () => {
    const batchSearch = vi.fn(async (input: { queries?: Array<{ category?: string; limit?: number }> }) => ({
      batch: true,
      searches: (input.queries ?? []).map((q, i) => ({
        label: q.category ?? `search_${i + 1}`,
        ...(q.category ? { category: q.category } : {}),
        results: [{ id: `${q.category ?? "x"}-${q.limit ?? 12}-1234567890`, name: `${q.category} part`, price: 1000 }]
      }))
    }));
    const tools = {
      search_products: { inputSchema: {}, execute: batchSearch },
      validate_build: { inputSchema: {}, execute: vi.fn(async () => ({ valid: true })) }
    } as unknown as ToolSet;
    const gated = gateResearchTools(tools, () => null, { validated: () => false, stepsUsed: () => 0 });
    const run = (input: unknown) => (gated.search_products.execute as Exec)(input, {});

    // Unknown top-level field must NOT bypass dedupe.
    await run({ queries: [{ category: "cpu", limit: 6 }, { category: "gpu", limit: 6 }], harmless_extra: "ignored" });
    const dup = (await run({ queries: [{ category: "cpu", limit: 6 }, { category: "gpu", limit: 6 }], harmless_extra: "ignored" })) as {
      search_closed?: boolean;
    };
    expect(dup.search_closed).toBe(true);
    expect(batchSearch).toHaveBeenCalledTimes(1);

    // Widening CPU search from limit 6 to limit 12 MUST run rather than being blocked as a repeat.
    const widened = (await run({ queries: [{ category: "cpu", limit: 12 }] })) as {
      batch: boolean;
      searches: Array<{ search_closed?: boolean; results: Array<{ id: string }> }>;
    };
    expect(batchSearch).toHaveBeenCalledTimes(2);
    expect(widened.searches[0].search_closed).toBeUndefined();
    expect(widened.searches[0].results[0].id).toContain("cpu-12");
  });

  it("unwraps and preserves MCP CallToolResult envelopes in gateResearchTools for partly repeated batches", async () => {
    const { mcpModelOutput } = await import("@/lib/alexa/mcp-tools");
    const mcpSearch = vi.fn(async (input: { queries?: Array<{ category?: string }> }) => {
      const domain = {
        batch: true,
        searches: (input.queries ?? []).map((q, i) => ({
          label: q.category ?? `search_${i + 1}`,
          ...(q.category ? { category: q.category } : {}),
          results: [
            {
              id: `${q.category ?? "x"}_0123456789abcdefghijklmnopqrstuvwxyz`,
              name: `${q.category} part`,
              category: q.category ?? "cpu",
              price: 5000,
              currency: "INR",
              country_code: "IN",
              retailer: "Shop",
              url: "https://example.com/long-url",
              in_stock: true
            }
          ]
        }))
      };
      return {
        content: [{ type: "text", text: JSON.stringify(domain) }],
        structuredContent: domain
      };
    });
    const tools = {
      search_products: {
        inputSchema: {},
        execute: mcpSearch,
        toModelOutput: ({ input, output }: { input: unknown; output: unknown }) =>
          mcpModelOutput("search_products", input, output as never)
      }
    } as unknown as ToolSet;

    const gated = gateResearchTools(tools, () => null, { validated: () => false, stepsUsed: () => 0 });
    const run = (input: unknown) => (gated.search_products.execute as Exec)(input, {});
    const toModel = (output: unknown) => (gated.search_products.toModelOutput as ToModel)({ input: {}, output });

    await run({ queries: [{ category: "cpu" }] });
    const second = (await run({ queries: [{ category: "cpu" }, { category: "gpu" }] })) as {
      content: Array<{ type: string; text: string }>;
      structuredContent: { batch: boolean; searches: Array<{ search_closed?: boolean; message?: string; results: Array<{ id: string }> }> };
    };
    // Preserves one valid CallToolResult envelope with merged per-slot repeat notice.
    expect(Array.isArray(second.content)).toBe(true);
    expect(second.structuredContent.batch).toBe(true);
    expect(second.structuredContent.searches[0].search_closed).toBe(true);
    expect(second.structuredContent.searches[0].message).toContain("Same call as step 1");
    expect(second.structuredContent.searches[1].results[0].id).toHaveLength(40);

    // Model view trims batch rows to 10-char IDs and drops URLs while keeping per-slot repeat notices.
    const modelOut = (await toModel(second)) as {
      type: string;
      value: { batch: boolean; searches: Array<{ search_closed?: boolean; message?: string; results: Array<Record<string, unknown>> }> };
    };
    expect(modelOut.value.batch).toBe(true);
    expect(modelOut.value.searches[0].search_closed).toBe(true);
    expect(modelOut.value.searches[1].results[0].id).toHaveLength(10);
    expect(modelOut.value.searches[1].results[0]).not.toHaveProperty("url");
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
