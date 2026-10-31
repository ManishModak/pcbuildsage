import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readUIMessageStream, type UIMessage } from "ai";

/**
 * Milestone 2 end to end on the integrated branch with a mocked model.
 *
 * Two halves, matching what a mock can and cannot prove:
 *
 * 1. Forcing: the evidence prompt's failure mode (validate, then a markdown
 *    table as if done). The engine must send `toolChoice: "required"` on the
 *    next model call, forbidding an end on text. Asserted by recording the
 *    call options the mock actually received. (A mock that ignores toolChoice
 *    still ends its own turn - the AI SDK v7 loop only continues on tool
 *    calls - so no mock can prove a real provider would present; the
 *    directives themselves are unit-tested in chat-engine-force-present.)
 * 2. Reload: a compliant turn (validate, present, explain) saved through the
 *    real sessions route and reloaded, with the build panel intact.
 */

const state = vi.hoisted(() => ({ model: null as unknown, catalog: null as unknown }));

vi.mock("better-sqlite3", async (importOriginal) => {
  const original = await importOriginal<typeof import("better-sqlite3")>();
  const Actual = typeof original === "function" ? original : (original as { default: typeof original }).default;
  class WrappedDatabase extends Actual {
    constructor(_dbPath: string, options?: unknown) {
      super(":memory:", options as never);
    }
  }
  return { default: WrappedDatabase };
});

vi.mock("@/lib/logger", () => ({ appendChatLog: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@ai-sdk/google", () => ({ createGoogleGenerativeAI: () => () => state.model }));
vi.mock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible: () => () => state.model }));

vi.mock("@/lib/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/catalog")>();
  return { ...actual, getCatalogRepository: () => state.catalog };
});

import { streamChat } from "@/lib/llm/chat-engine";
import { getSessionsDb } from "@/lib/sessions";
import { findAllBuildVersions, shouldAutoOpenPanel } from "../build-versions";
import { BuildCard } from "../build-card";
import { POST as saveRoute } from "@/app/api/sessions/route";
import { GET as getRoute } from "@/app/api/sessions/[id]/route";
import type { ChatUIMessage } from "../message";
import {
  createFakeCatalog,
  createScriptedModel,
  fixturePresentInput,
  fixtureValidateInput,
  testConfig,
  type FixtureCategory
} from "./helpers/chat-stream-harness";

const ALL_PARTS: FixtureCategory[] = ["gpu", "cpu", "motherboard", "ram", "storage", "psu", "case"];

const MARKDOWN_TABLE = [
  "Here are two options for your ₹60,000 1080p build:",
  "",
  "| Component | Option 1 |",
  "|---|---|",
  "| GPU | RTX 4060 |",
  "| CPU | Ryzen 5 5600 |"
].join("\n");

const EVIDENCE_PROMPT =
  "Gaming PC for 1080p, ₹60,000 budget, India. Give me 2 build options.";

function userMessage(text: string): UIMessage {
  return { role: "user", content: text, parts: [{ type: "text", text }] } as never;
}

describe("first run end to end", () => {
  const originalMode = process.env.PCBUILDSAGE_DEPLOYMENT_MODE;

  beforeEach(() => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "local";
    const db = getSessionsDb();
    db.exec("DELETE FROM sessions");
    db.exec("DELETE FROM session_tombstones");
  });

  afterEach(() => {
    if (originalMode !== undefined) process.env.PCBUILDSAGE_DEPLOYMENT_MODE = originalMode;
    else delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
  });

  it("forbids the provider from ending on text once a validation succeeded", async () => {
    state.catalog = createFakeCatalog();
    const toolChoices: unknown[] = [];
    const model = createScriptedModel([
      [
        { kind: "text", text: "Let me validate that build first." },
        { kind: "tool", toolCallId: "val-1", toolName: "validate_build", input: fixtureValidateInput(ALL_PARTS) }
      ],
      // The evidence failure mode: validated, then "done" with markdown tables.
      [{ kind: "text", text: MARKDOWN_TABLE }]
    ] as never);
    const inner = model.doStream.bind(model);
    model.doStream = (async (options: never) => {
      toolChoices.push((options as { toolChoice?: unknown }).toolChoice);
      return inner(options);
    }) as typeof model.doStream;
    state.model = model;

    const result = await streamChat(testConfig(), [userMessage(EVIDENCE_PROMPT)], undefined, undefined);
    const collected: UIMessage[] = [];
    const stream = result.toUIMessageStream({ originalMessages: [] as never });
    for await (const message of readUIMessageStream({ stream })) {
      collected.push(message);
    }

    const assistant = collected.at(-1) as ChatUIMessage;
    const kinds = (assistant.parts ?? []).map(
      (p) => `${(p as { type: string }).type}:${(p as { state?: string }).state}`
    );
    expect(kinds).toContain("tool-validate_build:output-available");
    // The mock ignores toolChoice and ends its own turn after the table...
    expect(toolChoices).toHaveLength(2);
    // ...but the engine forbade that ending: the call after the validation
    // required another tool call, so a compliant provider must present.
    expect(toolChoices[0]).toEqual({ type: "auto" });
    expect(toolChoices[1]).toEqual({ type: "required" });
  });

  it("reloads a presented turn with the chat and build panel intact", async () => {
    state.catalog = createFakeCatalog();
    state.model = createScriptedModel([
      [
        { kind: "text", text: "Let me validate that build first." },
        { kind: "tool", toolCallId: "val-1", toolName: "validate_build", input: fixtureValidateInput(ALL_PARTS) }
      ],
      [
        { kind: "tool", toolCallId: "present-1", toolName: "present_build", input: fixturePresentInput(ALL_PARTS) }
      ],
      [{ kind: "text", text: "Both options are above, pick your favourite." }]
    ] as never);

    const result = await streamChat(testConfig(), [userMessage(EVIDENCE_PROMPT)], undefined, undefined);
    const collected: UIMessage[] = [];
    const stream = result.toUIMessageStream({ originalMessages: [] as never });
    for await (const message of readUIMessageStream({ stream })) {
      collected.push(message);
    }

    const assistant = collected.at(-1) as ChatUIMessage;
    const kinds = (assistant.parts ?? []).map(
      (p) => `${(p as { type: string }).type}:${(p as { state?: string }).state}`
    );
    expect(kinds).toContain("tool-validate_build:output-available");
    expect(kinds).toContain("tool-present_build:output-available");

    const saved = await saveRoute(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "first-run",
          revision: 1,
          messages: [assistant],
          title: "Gaming PC",
          countryCode: "IN",
          currency: "INR"
        })
      })
    );
    expect(saved.status).toBe(200);

    const loaded = (await (
      await getRoute(new Request("http://localhost/api/sessions/first-run"), {
        params: Promise.resolve({ id: "first-run" })
      })
    ).json()) as { session: { messages: unknown[] } };
    const reloaded = loaded.session.messages as ChatUIMessage[];

    const versions = findAllBuildVersions(reloaded, "INR");
    expect(versions.length).toBeGreaterThan(0);
    expect(versions[0].kind).toBe("present");
    expect(shouldAutoOpenPanel(versions)).toBe(true);

    const markup = renderToStaticMarkup(<BuildCard versions={versions} inSidePanel />);
    expect(markup).toContain("NVIDIA GeForce RTX 4060 8GB");
    expect(markup).toContain("Max frames now");
  });
});
