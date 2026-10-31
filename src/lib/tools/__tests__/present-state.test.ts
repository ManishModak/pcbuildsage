import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { UIMessage } from "ai";
import { initializeSchema } from "@/lib/db";
import { SqliteCatalogRepository } from "@/lib/catalog/sqlite-repository";
import { deriveBuildsFromToolParts } from "@/features/chat/build-derive";
import { findAllBuildVersions } from "@/features/chat/build-versions";
import type { ToolPart } from "@/features/chat/tool-chip";
import { deriveBuildState } from "@/lib/llm/messages";
import { forcePresentDirectives, hasPresentedBuild, stopAfterFollowups } from "@/lib/llm/chat-engine";
import { createValidateBuildTool } from "../validate-build";
import { createPresentBuildTool } from "../present-build";
import { createTurnValidationStore } from "../turn-state";

vi.mock("@/lib/logger", () => ({ appendChatLog: vi.fn().mockResolvedValue(undefined) }));

// Real validate_build + present_build outputs, fed to every place that asks
// "was a build presented?" - the build panel, the engine's stop/force rules,
// and the resume state.

const I9 = "da6670a41d06377759be1c70e28f32230239c099";
const I5 = "c1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4";
const BOARD = "b2f9d25f2b06377759be1c70e28f32230239c200";
const scope = { countryCode: "IN", currency: "INR" };
const ctx = { toolCallId: "t", messages: [] } as never;

function insert(db: Database.Database, id: string, name: string, category: string, registryKey: string, price: number) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO products (id, name, normalized_name, registry_key, price, currency, country_code, retailer, url, image_url, in_stock, category, subcategory, specs, first_seen, last_scraped)
     VALUES (?, ?, ?, ?, ?, 'INR', 'IN', 'R', ?, NULL, 1, ?, NULL, NULL, ?, ?)`
  ).run(id, name, name.toLowerCase(), registryKey, price, `https://example.com/${id}`, category, now, now);
}

async function validateAB(repo: SqliteCatalogRepository) {
  const store = createTurnValidationStore();
  const validate = createValidateBuildTool(scope, repo, store);
  const validateInput = {
    builds: [
      { label: "Max Performance", parts: { cpu: { product_id: I9 }, motherboard: { product_id: BOARD } } },
      { label: "Within budget", parts: { cpu: { product_id: I5 }, motherboard: { product_id: BOARD } } }
    ]
  };
  const validateOutput = await validate.execute!(validateInput, ctx);
  const present = createPresentBuildTool(store);
  return { validateInput, validateOutput, present: (input: unknown) => present.execute!(input as never, ctx) as Promise<unknown> };
}

function toolPart(name: string, id: string, input: unknown, output: unknown): ToolPart {
  return { type: `tool-${name}`, toolCallId: id, state: "output-available", input, output } as unknown as ToolPart;
}

function assistant(id: string, parts: ToolPart[]): UIMessage {
  return { id, role: "assistant", parts } as unknown as UIMessage;
}

describe("present_build outcome across panel, engine and resume state", () => {
  let db: Database.Database;
  let repo: SqliteCatalogRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    initializeSchema(db);
    insert(db, I9, "Intel Core i9-14900K Desktop Processor", "cpu", "intel-core-i9-14900k", 55000);
    insert(db, I5, "Intel Core i5-14600K Desktop Processor", "cpu", "intel-core-i5-14600k", 28000);
    insert(db, BOARD, "ASUS ROG Strix Z790-E Gaming WiFi Motherboard", "motherboard", "asus-rog-strix-z790-e", 45000);
    repo = new SqliteCatalogRepository(db);
  });

  afterEach(async () => {
    await repo.close();
  });

  it("a rejected present_build is not a presented build anywhere", async () => {
    const { validateInput, validateOutput, present } = await validateAB(repo);
    const presentInput = { builds: [{ label: "Typo label" }] };
    const presentOutput = (await present(presentInput)) as { presented: boolean };
    expect(presentOutput.presented).toBe(false);

    // Panel: no card from the rejected input; the turn reads as validated-only.
    const parts = [
      toolPart("validate_build", "v1", validateInput, validateOutput),
      toolPart("present_build", "p1", presentInput, presentOutput)
    ];
    expect(deriveBuildsFromToolParts(parts, "INR")).toEqual([]);
    const versions = findAllBuildVersions([assistant("a1", parts)] as never, "INR");
    expect(versions.map((v) => v.kind)).toEqual(["validated"]);

    // Engine: still forced to present, and suggest_followups cannot end the turn.
    const steps = [
      { toolCalls: [{ toolName: "validate_build", toolCallId: "v1" }], toolResults: [{ toolCallId: "v1", toolName: "validate_build", output: validateOutput }] },
      {
        text: "Here is the build.",
        toolCalls: [{ toolName: "present_build", toolCallId: "p1" }, { toolName: "suggest_followups", toolCallId: "s1" }],
        toolResults: [
          { toolCallId: "p1", toolName: "present_build", output: presentOutput },
          { toolCallId: "s1", toolName: "suggest_followups", output: {} }
        ]
      }
    ];
    expect(hasPresentedBuild(steps)).toBe(false);
    expect(forcePresentDirectives(steps, 24)).toEqual({
      activeTools: ["present_build"],
      toolChoice: { type: "tool", toolName: "present_build" }
    });
    expect(stopAfterFollowups({ steps })).toBe(false);

    // Resume state: the validation, not the rejected present - also when the
    // rejected call carried product IDs (here, ones its snapshot never had).
    expect(deriveBuildState([assistant("a1", parts)])?.source).toBe("validate_build");
    const wrongIdsInput = { builds: [{ label: "Max Performance", product_ids: [I5.slice(0, 10), BOARD.slice(0, 10)] }] };
    const wrongIdsOutput = (await present(wrongIdsInput)) as { presented: boolean };
    expect(wrongIdsOutput.presented).toBe(false);
    const state = deriveBuildState([
      assistant("a1", [parts[0], toolPart("present_build", "p2", wrongIdsInput, wrongIdsOutput)])
    ]);
    expect(state?.source).toBe("validate_build");
    expect(state?.parts).toEqual(validateInput.builds[0].parts);
  });

  it("a label-only present of the second validated build resumes from that build", async () => {
    const { validateInput, validateOutput, present } = await validateAB(repo);
    const presentInput = { builds: [{ label: "Within budget" }] };
    const presentOutput = (await present(presentInput)) as { presented: boolean };
    expect(presentOutput.presented).toBe(true);

    const state = deriveBuildState([
      assistant("a1", [
        toolPart("validate_build", "v1", validateInput, validateOutput),
        toolPart("present_build", "p1", presentInput, presentOutput)
      ])
    ]);
    expect(state?.source).toBe("present_build");
    expect(state?.parts).toEqual([I5, BOARD]);
    const snapshot = state?.snapshot as { label: string; components: Array<{ product_id: string }> };
    expect(snapshot.label).toBe("Within budget");
    expect(snapshot.components.map((c) => c.product_id)).toContain(I5);
  });
});
