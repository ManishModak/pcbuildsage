import { beforeEach, describe, expect, it, vi } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { MockLanguageModelV4 } from "ai/test";
import Database from "better-sqlite3";
import { initializeSchema } from "@/lib/db";
import { SqliteCatalogRepository } from "@/lib/catalog/sqlite-repository";
import { createToolRegistry } from "@/lib/tools";

// What the model receives at each step of a normal turn, through the real AI SDK loop.
const state = vi.hoisted(() => ({
  requests: [] as Array<{ tools: string; system: string; prompt: unknown[] }>,
  script: [] as unknown[][]
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: () => () =>
    new MockLanguageModelV4({
      doStream: async (options) => {
        state.requests.push({
          tools: JSON.stringify(options.tools ?? []),
          system: JSON.stringify(options.prompt.filter((message) => message.role === "system")),
          prompt: options.prompt
        });
        const parts = state.script.shift() ?? [];
        const calls = parts.some((part) => (part as { type: string }).type === "tool-call");
        const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
        return {
          stream: new ReadableStream({
            start(controller) {
              for (const part of [{ type: "stream-start", warnings: [] }, ...parts]) controller.enqueue(part);
              controller.enqueue({ type: "finish", finishReason: { unified: calls ? "tool-calls" : "stop", raw: "x" }, usage });
              controller.close();
            }
          })
        } as never;
      }
    })
}));

vi.mock("@/lib/logger", () => ({ appendChatLog: vi.fn().mockResolvedValue(undefined) }));

import { resolveConfig } from "@/lib/config";
import { streamChat } from "../chat-engine";

const call = (id: string, toolName: string, input: unknown) => ({ type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) });
const text = (value: string) => [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: value }, { type: "text-end", id: "t" }];
const anyInput = z.object({}).passthrough();
const WHOLE_BUILD = [{ category: "cpu" }, { category: "motherboard" }, { category: "ram" }, { category: "storage" }, { category: "psu" }, { category: "case" }];

const tools = {
  search_products: tool({ description: "search", inputSchema: anyInput, execute: async () => ({ results: [] }) }),
  validate_build: tool({
    description: "validate",
    inputSchema: anyInput,
    execute: async () => ({ builds: { "Within budget": { valid: true, issues: [], snapshot: { label: "Within budget", components: WHOLE_BUILD } } } })
  }),
  present_build: tool({ description: "present", inputSchema: anyInput, execute: async () => ({ presented: true, buildCount: 1, builds: [{ label: "Within budget" }] }) }),
  suggest_followups: tool({ description: "followups", inputSchema: anyInput, execute: async () => ({ prompts: ["Add a GPU later"] }) })
};

function expectStrictAppendOnlyPrompts(requests: Array<{ tools: string; system: string; prompt: unknown[] }>) {
  expect(new Set(requests.map((r) => r.tools)).size).toBe(1);
  expect(new Set(requests.map((r) => r.system)).size).toBe(1);
  for (let i = 1; i < requests.length; i++) {
    const prev = requests[i - 1].prompt;
    const curr = requests[i].prompt;
    expect(curr.length).toBeGreaterThan(prev.length);
    expect(JSON.stringify(curr.slice(0, prev.length))).toBe(JSON.stringify(prev));
  }
}

function seedCatalog() {
  const db = new Database(":memory:");
  initializeSchema(db);
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO products (id, name, normalized_name, registry_key, price, currency, country_code, retailer, url, image_url, in_stock, category, subcategory, specs, first_seen, last_scraped)
     VALUES (?, ?, ?, ?, ?, 'INR', 'IN', 'Shop', ?, NULL, 1, ?, NULL, ?, ?, ?)`
  );
  const rows: Array<[string, string, string, number, string, Record<string, unknown>]> = [
    ["1111111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "AMD Ryzen 5 5600G", "amd-ryzen-5-5600g", 11000, "cpu", { socket: "AM4", ddr: "DDR4", tdp_w: 65, igpu: true }],
    ["2222222222aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "MSI B550M Pro-VDH", "msi-b550m-pro-vdh", 9000, "motherboard", { socket: "AM4", ddr: "DDR4", form_factor: "mATX" }],
    ["3333333333aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "Corsair Vengeance 16GB (2x8GB) DDR4", "corsair-16gb-ddr4", 3500, "ram", { ddr: "DDR4", capacity_gb: 16, modules: 2 }],
    ["4444444444aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "WD Blue SN580 500GB NVMe", "wd-sn580-500gb", 3500, "storage", { interface: "nvme", capacity_gb: 500 }],
    ["5555555555aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "MSI MAG A550BN 550W", "msi-a550bn", 3500, "psu", { wattage: 550 }],
    ["6666666666aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "Deepcool Matrexx 40", "deepcool-matrexx-40", 3500, "case", { form_factor: "mATX", max_gpu_length_mm: 320, max_cooler_height_mm: 165 }]
  ];
  for (const [id, name, key, price, cat, specs] of rows) {
    insert.run(id, name, name.toLowerCase(), key, price, `https://example.com/${id}`, cat, JSON.stringify(specs), now, now);
  }
  return new SqliteCatalogRepository(db);
}

describe("prompt prefix across a turn", () => {
  beforeEach(() => {
    state.requests = [];
    state.script = [];
  });

  it("sends the same system prompt and tool list at every step of a normal turn", async () => {
    // Search, validate, present, then answer: the steps where the harness changes its directives.
    state.script = [
      [call("s1", "search_products", { category: "cpu" })],
      [call("v1", "validate_build", { builds: [] })],
      [call("p1", "present_build", { builds: [{ label: "Within budget" }] })],
      [...text("Here it is."), call("f1", "suggest_followups", { prompts: ["Add a GPU later"] })]
    ];
    const chain = [{ provider: "openai-compatible" as const, model: "m", baseUrl: "http://127.0.0.1:1/v1", keySource: "none" as const, contextLimit: 131072 }];
    const config = resolveConfig({ llmChain: chain, chatLlmChain: chain, subagentLlmChain: chain, dbPath: ":memory:", countryCode: "IN", currency: "INR", searchProvider: "none" });
    const result = await streamChat(config, [{ role: "user", content: "Office PC under ₹35,000" }], undefined, undefined, null, undefined, { tools });
    for await (const part of result.fullStream) void part;
    // A changed prefix makes a local server re-read the whole prompt (r32: ~20 s per re-read on Ornith).
    expect(state.requests).toHaveLength(4);
    expectStrictAppendOnlyPrompts(state.requests);
  });

  it("keeps tools, system, and message prefixes strictly append-only across batch search, validate, and present_build with followups", async () => {
    const repo = seedCatalog();
    try {
      const chain = [{ provider: "openai-compatible" as const, model: "m", baseUrl: "http://127.0.0.1:1/v1", keySource: "none" as const, contextLimit: 131072 }];
      const config = {
        ...resolveConfig({ llmChain: chain, chatLlmChain: chain, subagentLlmChain: chain, dbPath: ":memory:", countryCode: "IN", currency: "INR", searchProvider: "none" }),
        dbPath: ""
      };
      const realTools = createToolRegistry(config, { repository: repo, requireCatalogParts: false });

      state.script = [
        [
          call("b1", "search_products", {
            queries: [
              { category: "cpu" },
              { category: "motherboard" },
              { category: "ram" },
              { category: "storage" },
              { category: "psu" },
              { category: "case" }
            ]
          })
        ],
        [
          call("v1", "validate_build", {
            budget: 35000,
            builds: [
              {
                label: "Within budget",
                parts: {
                  cpu: { product_id: "1111111111" },
                  motherboard: { product_id: "2222222222" },
                  ram: { product_id: "3333333333" },
                  storage: { product_id: "4444444444" },
                  psu: { product_id: "5555555555" },
                  case: { product_id: "6666666666" }
                }
              }
            ]
          })
        ],
        // present_build with followups but NO text yet: must NOT stop before the explanation step.
        [call("p1", "present_build", { builds: [{ label: "Within budget" }], followups: ["Add a dedicated GPU later"] })],
        [...text("This Ryzen 5 5600 build fits neatly under ₹35,000.")]
      ];

      const result = await streamChat(config, [{ role: "user", content: "Office PC under ₹35,000" }], undefined, undefined, null, undefined, { tools: realTools });
      for await (const part of result.fullStream) void part;

      expect(state.requests).toHaveLength(4);
      expectStrictAppendOnlyPrompts(state.requests);
    } finally {
      await repo.close();
    }
  });

  it("ends cleanly in 3 steps when assistant text accompanies present_build with followups", async () => {
    const repo = seedCatalog();
    try {
      const chain = [{ provider: "openai-compatible" as const, model: "m", baseUrl: "http://127.0.0.1:1/v1", keySource: "none" as const, contextLimit: 131072 }];
      const config = {
        ...resolveConfig({ llmChain: chain, chatLlmChain: chain, subagentLlmChain: chain, dbPath: ":memory:", countryCode: "IN", currency: "INR", searchProvider: "none" }),
        dbPath: ""
      };
      const realTools = createToolRegistry(config, { repository: repo, requireCatalogParts: false });

      state.script = [
        [
          call("b1", "search_products", {
            queries: [
              { category: "cpu" },
              { category: "motherboard" },
              { category: "ram" },
              { category: "storage" },
              { category: "psu" },
              { category: "case" }
            ]
          })
        ],
        [
          call("v1", "validate_build", {
            budget: 35000,
            builds: [
              {
                label: "Within budget",
                parts: {
                  cpu: { product_id: "1111111111" },
                  motherboard: { product_id: "2222222222" },
                  ram: { product_id: "3333333333" },
                  storage: { product_id: "4444444444" },
                  psu: { product_id: "5555555555" },
                  case: { product_id: "6666666666" }
                }
              }
            ]
          })
        ],
        [
          ...text("Here is your balanced ₹34,000 office build."),
          call("p1", "present_build", { builds: [{ label: "Within budget" }], followups: ["Upgrade to 32GB RAM"] })
        ],
        // Sentinel extra step that must NOT run if stopAfterFollowups works.
        [...text("Should not reach step 4.")]
      ];

      const result = await streamChat(config, [{ role: "user", content: "Office PC under ₹35,000" }], undefined, undefined, null, undefined, { tools: realTools });
      for await (const part of result.fullStream) void part;

      expect(state.requests).toHaveLength(3);
      expectStrictAppendOnlyPrompts(state.requests);
    } finally {
      await repo.close();
    }
  });
});
