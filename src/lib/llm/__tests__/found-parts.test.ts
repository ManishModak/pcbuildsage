import { describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import { rememberFoundParts } from "../found-parts";

type Exec = (input: unknown, options: unknown) => Promise<unknown>;
type ToModel = (args: { output: unknown }) => Promise<{ type: string; value: Record<string, unknown> }>;

const cpuRows = [
  { id: "9df61d0c3d116507c9376a6c911a8fb5f3daabef", name: "AMD Ryzen 5 5600G", price: 14090 },
  { id: "7325298fc2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "AMD Ryzen 3 3200G", price: 6500 },
  { id: "93fee6d861aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "AMD Athlon 3000G", price: 4000 },
  { id: "1111111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "AMD Ryzen 5 5500", price: 9000 }
];

function wrapped(validateValue: unknown) {
  const tools = {
    search_products: { inputSchema: {}, execute: vi.fn(async () => ({ results: cpuRows })) },
    validate_build: { inputSchema: {}, execute: vi.fn(), toModelOutput: async () => ({ type: "json", value: validateValue }) }
  } as unknown as ToolSet;
  return rememberFoundParts(tools);
}

describe("rememberFoundParts", () => {
  it("lists the latest search's top rows for each category a build left out", async () => {
    const tools = wrapped({ builds: { A: { valid: true, missing_parts: ["cpu", "ram"] } } });
    await (tools.search_products.execute as Exec)({ category: "CPU" }, {});
    const out = await (tools.validate_build.toModelOutput as unknown as ToModel)({ output: {} });
    // ram was never searched, so only cpu is listed; IDs shortened to the 10-char prefix.
    expect(out.value.found_earlier).toEqual({
      cpu: [
        { id: "9df61d0c3d", name: "AMD Ryzen 5 5600G", price: 14090 },
        { id: "7325298fc2", name: "AMD Ryzen 3 3200G", price: 6500 },
        { id: "93fee6d861", name: "AMD Athlon 3000G", price: 4000 }
      ]
    });
  });

  it("leaves a whole build's result unchanged", async () => {
    const value = { builds: { A: { valid: true } } };
    const tools = wrapped(value);
    await (tools.search_products.execute as Exec)({ category: "cpu" }, {});
    await expect((tools.validate_build.toModelOutput as unknown as ToModel)({ output: {} })).resolves.toEqual({ type: "json", value });
  });

  it("names a part an earlier validate call had that a later build leaves out", async () => {
    const value = { builds: { A: { valid: true } } };
    const execute = vi.fn(async () => ({}));
    const tools = rememberFoundParts({
      search_products: { inputSchema: {}, execute: vi.fn(async () => ({ results: [{ id: "c374fb1b25aaaa", name: "RTX 5080", price: 120000 }] })) },
      validate_build: { inputSchema: {}, execute, toModelOutput: async () => ({ type: "json", value }) }
    } as unknown as ToolSet);
    const run = tools.validate_build.execute as Exec;
    const toModel = tools.validate_build.toModelOutput as unknown as (a: { toolCallId: string; output: unknown }) => Promise<{ value: Record<string, unknown> }>;
    await (tools.search_products.execute as Exec)({ category: "gpu" }, {});
    await run({ builds: [{ label: "Spot", parts: { gpu: { product_id: "c374fb1b25" }, case: { product_id: "c2e05370d9" } } }] }, { toolCallId: "v1" });
    expect((await toModel({ toolCallId: "v1", output: {} })).value).not.toHaveProperty("dropped_parts_note");
    await run({ builds: [{ label: "4K", parts: { cpu: { product_id: "a77b1bd955" }, case: { product_id: "c2e05370d9" } } }] }, { toolCallId: "v2" });
    const out = await toModel({ toolCallId: "v2", output: {} });
    expect(out.value.dropped_parts_note).toContain('"4K" leaves out gpu (c374fb1b25 RTX 5080)');
    expect(out.value.builds).toEqual(value.builds);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("remembers candidates from batch searches and freezes per-call reminders for stable replay", async () => {
    const validateOutput = { builds: { A: { valid: true, missing_parts: ["cpu", "ram"] } } };
    const searchExecute = vi
      .fn()
      .mockResolvedValueOnce({
        batch: true,
        searches: [
          { label: "cpu", category: "cpu", results: cpuRows },
          { label: "gpu", category: "gpu", results: [{ id: "g111111111aaaa", name: "RTX 4070", price: 55000 }] }
        ]
      })
      .mockResolvedValueOnce({
        batch: true,
        searches: [{ label: "ram", category: "ram", results: [{ id: "r111111111aaaa", name: "16GB DDR5", price: 5000 }] }]
      });
    const tools = rememberFoundParts({
      search_products: { inputSchema: {}, execute: searchExecute },
      validate_build: {
        inputSchema: {},
        execute: vi.fn(async () => validateOutput),
        toModelOutput: async () => ({ type: "json", value: validateOutput })
      }
    } as unknown as ToolSet);

    await (tools.search_products.execute as Exec)({ queries: [{ category: "cpu" }, { category: "gpu" }] }, {});
    await (tools.validate_build.execute as Exec)({ builds: [{ label: "A", parts: {} }] }, { toolCallId: "v-batch" });
    const firstView = await (tools.validate_build.toModelOutput as unknown as (a: { toolCallId: string; output: unknown }) => Promise<{ value: Record<string, unknown> }>)({
      toolCallId: "v-batch",
      output: validateOutput
    });
    expect(firstView.value.found_earlier).toEqual({
      cpu: [
        { id: "9df61d0c3d", name: "AMD Ryzen 5 5600G", price: 14090 },
        { id: "7325298fc2", name: "AMD Ryzen 3 3200G", price: 6500 },
        { id: "93fee6d861", name: "AMD Athlon 3000G", price: 4000 }
      ]
    });

    // A later RAM search must NOT mutate the earlier v-batch tool result on replay.
    await (tools.search_products.execute as Exec)({ queries: [{ category: "ram" }] }, {});
    const replayedView = await (tools.validate_build.toModelOutput as unknown as (a: { toolCallId: string; output: unknown }) => Promise<{ value: Record<string, unknown> }>)({
      toolCallId: "v-batch",
      output: validateOutput
    });
    expect(replayedView.value).toEqual(firstView.value);
  });
});
