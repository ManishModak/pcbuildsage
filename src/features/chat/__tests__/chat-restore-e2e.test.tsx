import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readUIMessageStream, type UIMessage } from "ai";

/**
 * End-to-end: a real `streamChat` driven by the AI SDK's mocked model, a real
 * `validate_build` against a real tool registry, a real save, a real reload, and the
 * real build panel rendered from what came back.
 *
 * The guarantee under test is the one a user actually experiences: if the tab closes
 * (or the stream is interrupted) part-way through a `present_build`, the build panel
 * must still show the validated build after a reload — never a blank panel and never a
 * card that claims a total the data does not support.
 */

const state = vi.hoisted(() => ({ model: null as unknown, catalog: null as unknown }));

// An in-memory SQLite for the real sessions routes, so the HTTP layer is exercised
// end to end without touching data/sessions.db.
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

// Mock the provider factory rather than `createLanguageModel`: `client.ts` calls it
// lexically, so mocking its export would not intercept anything. `client.ts` and the
// real `streamText` stay untouched and drive MockLanguageModelV4.
vi.mock("@ai-sdk/google", () => ({ createGoogleGenerativeAI: () => () => state.model }));
vi.mock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible: () => () => state.model }));

vi.mock("@/lib/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/catalog")>();
  return { ...actual, getCatalogRepository: () => state.catalog };
});

import { streamChat } from "@/lib/llm/chat-engine";
import { getSessionsDb } from "@/lib/sessions";
import {
  getClientSession,
  saveClientSession,
  resetClientStoreState
} from "@/lib/sessions/client-store";
import { SessionSaveQueue, sessionSignature } from "../session-save-queue";
import { findAllBuildVersions } from "../build-versions";
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

/**
 * What the user actually reads: markup with tags stripped and the entities React emits
 * decoded. Assertions about product ids and label copy belong here rather than on raw
 * markup, where a legitimate retailer link or an escaped apostrophe would give a
 * misleading result.
 */
function visibleText(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, "/")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * A minimal IndexedDB whose ordering matches the documented one: a request's
 * `onsuccess` fires first, and the transaction's `oncomplete` only afterwards. MDN is
 * explicit that request success "does not mean the item has been stored successfully
 * in the DB - for that you need transaction.oncomplete", and that ordering is exactly
 * what the save path must not get wrong.
 *
 * The backing map is module-scoped so a "reload" (reset the store, reinstall the
 * driver) still sees what was written before it.
 */
const fakeStores = new Map<string, Map<string, unknown>>();

function installFakeIndexedDb(): void {
  const newRequest = () =>
    ({ result: undefined as unknown, error: null, onsuccess: null, onerror: null }) as unknown as Record<string, unknown>;

  (globalThis as unknown as { indexedDB: unknown }).indexedDB = {
    open() {
      const request = newRequest() as Record<string, unknown> & {
        result: unknown;
        onsuccess?: () => void;
      };
      queueMicrotask(() => {
        const db = {
          objectStoreNames: { contains: (name: string) => fakeStores.has(name) },
          createObjectStore(name: string) {
            if (!fakeStores.has(name)) fakeStores.set(name, new Map());
            return { createIndex() {} };
          },
          close() {},
          transaction(names: string | string[]) {
            // Real IndexedDB scopes a transaction over one store or a list;
            // the atomic save opens its revision-check transaction over both
            // the session and tombstone stores, so the fake must resolve each
            // objectStore() call to its own named map.
            const scope = Array.isArray(names) ? names : [names];
            const maps = new Map<string, Map<string, unknown>>();
            for (const name of scope) {
              const map = fakeStores.get(name) ?? new Map<string, unknown>();
              fakeStores.set(name, map);
              maps.set(name, map);
            }
            const tx: Record<string, unknown> = { oncomplete: null, onerror: null, onabort: null };
            // The commit notification is delivered after the request, never before.
            const commit = () => queueMicrotask(() => (tx.oncomplete as (() => void) | null)?.());
            const objectStore = (name?: string) => {
              const map = (name !== undefined ? maps.get(name) : undefined) ?? maps.get(scope[0]) ?? new Map<string, unknown>();
              return {
              get(key: string) {
                const r = newRequest() as Record<string, unknown> & { onsuccess?: () => void };
                queueMicrotask(() => {
                  r.result = map.get(key);
                  r.onsuccess?.();
                  commit();
                });
                return r;
              },
              getAll() {
                const r = newRequest() as Record<string, unknown> & { onsuccess?: () => void };
                queueMicrotask(() => {
                  r.result = Array.from(map.values());
                  r.onsuccess?.();
                  commit();
                });
                return r;
              },
              put(value: { id: string }) {
                const r = newRequest() as Record<string, unknown> & { onsuccess?: () => void };
                queueMicrotask(() => {
                  map.set(value.id, JSON.parse(JSON.stringify(value)));
                  r.onsuccess?.();
                  commit();
                });
                return r;
              },
              delete(key: string) {
                const r = newRequest() as Record<string, unknown> & { onsuccess?: () => void };
                queueMicrotask(() => {
                  map.delete(key);
                  r.onsuccess?.();
                  commit();
                });
                return r;
              },
              clear() {
                const r = newRequest() as Record<string, unknown> & { onsuccess?: () => void };
                queueMicrotask(() => {
                  map.clear();
                  r.onsuccess?.();
                  commit();
                });
                return r;
              }
              };
            };
            (tx as { objectStore: () => unknown }).objectStore = objectStore;
            return tx;
          }
        };
        request.result = db;
        request.onsuccess?.();
      });
      return request;
    }
  };
}

/**
 * Drive a real turn that validates a build, starts to present it, and is then
 * interrupted — the shape of a session saved when a tab closes mid-turn.
 */
async function interruptedTurn(options: { presentInterrupted: boolean }): Promise<UIMessage[]> {
  const steps = [
    [
      { kind: "text" as const, text: "Let me validate that build first." },
      {
        kind: "tool" as const,
        toolCallId: "val-1",
        toolName: "validate_build",
        input: fixtureValidateInput(ALL_PARTS)
      }
    ]
  ];

  if (options.presentInterrupted) {
    // The presentation starts and never finishes: the stream hangs and the caller aborts.
    steps.push([
      {
        kind: "tool" as const,
        toolCallId: "present-1",
        toolName: "present_build",
        input: fixturePresentInput(ALL_PARTS)
      },
      { kind: "hang" as const }
    ] as never);
  } else {
    // The real stuck session: the turn never gets as far as presenting at all.
    steps.push([{ kind: "hang" as const }] as never);
  }

  state.catalog = createFakeCatalog();
  const controller = new AbortController();
  state.model = createScriptedModel(steps as never, { signal: controller.signal });

  const result = await streamChat(
    testConfig(),
    [
      {
        role: "user",
        content: "Budget gaming build strictly under 45000",
        parts: [{ type: "text", text: "Budget gaming build strictly under 45000" }]
      }
    ] as never,
    undefined,
    controller.signal
  );

  const collected: UIMessage[] = [];
  const stream = result.toUIMessageStream({ originalMessages: [] as never });
  try {
    // Drain to completion rather than breaking out: the mock's hung stream closes on
    // abort, so the loop ends on its own. Breaking would cancel the reader and make
    // the SDK's teardown close an already-closed controller.
    for await (const message of readUIMessageStream({ stream })) {
      collected.push(message);
      const parts = (message.parts ?? []) as Array<{ type: string; state?: string }>;
      // Abort at the exact moment the condition under test is reached: the
      // presentation being in flight, or (when there is none) the validation landing.
      const presentInFlight = parts.some(
        (part) => part.type === "tool-present_build" && part.state !== "output-available"
      );
      const validated = parts.some(
        (part) => part.type === "tool-validate_build" && part.state === "output-available"
      );
      if (options.presentInterrupted ? presentInFlight : validated) controller.abort();
    }
  } catch {
    // Interrupting the stream is the condition under test.
  }
  return collected;
}

function saveViaApi(id: string, messages: UIMessage[], revision: number): Promise<Response> {
  return saveRoute(
    new Request("http://localhost/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, revision, messages, title: "Budget build", countryCode: "IN", currency: "INR" })
    })
  );
}

function loadViaApi(id: string): Promise<Response> {
  return getRoute(new Request(`http://localhost/api/sessions/${id}`), {
    params: Promise.resolve({ id })
  });
}

describe("interrupted stream -> reload -> build panel", () => {
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

  it("saves a real validated build when the presentation is interrupted mid-flight", async () => {
    const streamed = await interruptedTurn({ presentInterrupted: true });
    const assistant = streamed.at(-1) as ChatUIMessage | undefined;
    const kinds = (assistant?.parts ?? []).map((p) => `${p.type}:${(p as { state?: string }).state}`);
    // The shape under test: a finished validation, and a presentation with no output.
    expect(kinds).toContain("tool-validate_build:output-available");
    // An interrupted presentation has input but no output; either pending state counts.
    expect(
      kinds.some(
        (k) => k.startsWith("tool-present_build:") && !k.includes("output-available")
      )
    ).toBe(true);

    const response = await saveViaApi("e2e-interrupted", [assistant as ChatUIMessage], 1);
    expect(response.status).toBe(200);

    const loaded = (await (await loadViaApi("e2e-interrupted")).json()) as {
      session: { messages: unknown[] };
    };
    const reloaded = loaded.session.messages as ChatUIMessage[];

    const versions = findAllBuildVersions(reloaded, "INR");
    expect(versions.length).toBeGreaterThan(0);
    expect(versions[0].label).toBe("Validated — not presented yet");

    const markup = renderToStaticMarkup(<BuildCard versions={versions} inSidePanel />);
    const text = visibleText(markup);
    // The panel must show the build, not an empty card, and must not invent a total:
    // this fixture has an unpriced part, so the snapshot total is legitimately null.
    expect(text).toContain("NVIDIA GeForce RTX 4060 8GB");
    expect(text).toContain("Max frames now");
    expect(text).not.toContain("₹0.00");
    expect(text).toContain("—");
  });

  it("shows the validated build when the turn never reached present_build at all", async () => {
    const streamed = await interruptedTurn({ presentInterrupted: false });
    const assistant = streamed.at(-1) as ChatUIMessage;
    const kinds = (assistant.parts ?? []).map((p) => `${p.type}:${(p as { state?: string }).state}`);
    expect(kinds).toContain("tool-validate_build:output-available");
    expect(kinds.some((k) => k.startsWith("tool-present_build"))).toBe(false);

    await saveViaApi("e2e-never-presented", [assistant], 1);
    const loaded = (await (await loadViaApi("e2e-never-presented")).json()) as {
      session: { messages: unknown[] };
    };

    const versions = findAllBuildVersions(loaded.session.messages as ChatUIMessage[], "INR");
    expect(versions[0].label).toBe("Validated — not presented yet");
    const markup = renderToStaticMarkup(<BuildCard versions={versions} inSidePanel />);
    expect(markup).toContain("NVIDIA GeForce RTX 4060 8GB");
    expect(markup).not.toContain("₹0.00");
  });

  it("keeps a completed total when every part is priced", async () => {
    const priced: FixtureCategory[] = ["gpu", "cpu", "motherboard", "ram", "storage", "psu"];
    state.catalog = createFakeCatalog();
    const pricedController = new AbortController();
    state.model = createScriptedModel(
      [
        [
          {
            kind: "tool",
            toolCallId: "val-1",
            toolName: "validate_build",
            input: fixtureValidateInput(priced, "Fully priced")
          }
        ],
        [{ kind: "hang" }]
      ] as never,
      { signal: pricedController.signal }
    );

    const result = await streamChat(
      testConfig(),
      [{ role: "user", content: "build", parts: [{ type: "text", text: "build" }] }] as never,
      undefined,
      pricedController.signal
    );
    const collected: UIMessage[] = [];
    try {
      const stream = result.toUIMessageStream({ originalMessages: [] as never });
      for await (const message of readUIMessageStream({ stream })) {
        collected.push(message);
        const parts = (message.parts ?? []) as Array<{ type: string; state?: string }>;
        if (parts.some((p) => p.type === "tool-validate_build" && p.state === "output-available")) {
          pricedController.abort();
        }
      }
    } catch {
      /* interrupted on purpose */
    }

    const assistant = collected.at(-1) as ChatUIMessage;
    const versions = findAllBuildVersions([assistant], "INR");
    const markup = renderToStaticMarkup(<BuildCard versions={versions} inSidePanel />);
    // 31500 + 13490 + 9450 + 2899 + 4199 + 3499 = 65037
    const text = visibleText(markup);
    expect(text).toContain("65,037");
    expect(text).not.toContain("—");
  });
});

/**
 * Hosted mode: no server sessions at all. The same interrupted turn is written to
 * IndexedDB through the real browser store and read back the way a reload would.
 */
describe("interrupted stream -> hosted store -> build panel", () => {
  const originalMode = process.env.PCBUILDSAGE_DEPLOYMENT_MODE;

  beforeEach(() => {
    process.env.PCBUILDSAGE_DEPLOYMENT_MODE = "hosted-demo";
    resetClientStoreState();
    installFakeIndexedDb();
  });

  afterEach(() => {
    if (originalMode !== undefined) process.env.PCBUILDSAGE_DEPLOYMENT_MODE = originalMode;
    else delete process.env.PCBUILDSAGE_DEPLOYMENT_MODE;
    resetClientStoreState();
  });

  it("round-trips an interrupted turn through IndexedDB and still shows the build", async () => {
    const streamed = await interruptedTurn({ presentInterrupted: true });
    const assistant = streamed.at(-1) as ChatUIMessage;

    const queue = new SessionSaveQueue((request) => saveClientSession(request), sessionSignature([]));
    await queue.enqueue(sessionSignature([assistant]), {
      id: "hosted-interrupted",
      messages: [assistant],
      title: "Budget build",
      countryCode: "IN",
      currency: "INR"
    });

    // Reload: a brand-new client store reading the same storage, as after F5.
    resetClientStoreState();
    installFakeIndexedDb();
    const reloaded = await getClientSession("hosted-interrupted");
    expect(reloaded).not.toBeNull();

    const versions = findAllBuildVersions(reloaded!.messages as ChatUIMessage[], "INR");
    expect(versions.length).toBeGreaterThan(0);
    expect(versions[0].label).toBe("Validated — not presented yet");

    const markup = renderToStaticMarkup(<BuildCard versions={versions} inSidePanel />);
    const text = visibleText(markup);
    expect(text).toContain("NVIDIA GeForce RTX 4060 8GB");
    expect(text).not.toContain("₹0.00");
  });

  it("loads a stuck tool call as interrupted rather than spinning forever", async () => {
    const streamed = await interruptedTurn({ presentInterrupted: true });
    const assistant = streamed.at(-1) as ChatUIMessage;

    await saveClientSession({ id: "hosted-stuck", revision: 1, messages: [assistant] });
    resetClientStoreState();
    installFakeIndexedDb();

    const reloaded = await getClientSession("hosted-stuck");
    const parts = (reloaded!.messages as ChatUIMessage[]).at(-1)?.parts ?? [];
    const stuck = parts.find((p) => p.type === "tool-present_build") as { state?: string; errorText?: string } | undefined;
    expect(stuck).toBeDefined();
    // A finished turn must not leave a tool call that renders a spinner forever.
    expect(stuck!.state).toBe("output-error");
    expect(stuck!.errorText).toBe("Interrupted");
    // The completed validation must survive the repair untouched.
    const validated = parts.find((p) => p.type === "tool-validate_build") as { state?: string } | undefined;
    expect(validated?.state).toBe("output-available");
  });

  it("keeps two chats separate when the user switches mid-stream", async () => {
    // Chat A is interrupted mid-presentation and persisted; chat B is a different
    // conversation. Switching must never blend them, and neither may lose its own
    // partially-streamed turn.
    const streamedA = await interruptedTurn({ presentInterrupted: true });
    const assistantA = streamedA.at(-1) as ChatUIMessage;
    const assistantB: ChatUIMessage = {
      id: "b-1",
      role: "assistant",
      parts: [{ type: "text", text: "A different answer about a workstation." }]
    };

    const queueA = new SessionSaveQueue((request) => saveClientSession(request), sessionSignature([]));
    const queueB = new SessionSaveQueue((request) => saveClientSession(request), sessionSignature([]));
    await queueA.enqueue(sessionSignature([assistantA]), {
      id: "switch-a",
      messages: [assistantA],
      title: "A",
      countryCode: "IN",
      currency: "INR"
    });
    await queueB.enqueue(sessionSignature([assistantB]), {
      id: "switch-b",
      messages: [assistantB],
      title: "B",
      countryCode: "IN",
      currency: "INR"
    });

    resetClientStoreState();
    installFakeIndexedDb();
    const reloadedA = await getClientSession("switch-a");
    const reloadedB = await getClientSession("switch-b");

    // A keeps its interrupted build; B has no build at all and shows none.
    const versionsA = findAllBuildVersions(reloadedA!.messages as ChatUIMessage[], "INR");
    const versionsB = findAllBuildVersions(reloadedB!.messages as ChatUIMessage[], "INR");
    expect(versionsA.length).toBeGreaterThan(0);
    expect(versionsB).toHaveLength(0);
    expect(renderToStaticMarkup(<BuildCard versions={versionsB} inSidePanel />)).toBe("");

    // And B's text is nowhere in A's transcript.
    const textA = JSON.stringify(reloadedA!.messages);
    expect(textA).not.toContain("workstation");
    expect(JSON.stringify(reloadedB!.messages)).not.toContain("validate_build");
  });
});

describe("sessions that predate the current format", () => {
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

  it("renders a legacy session that has content strings instead of parts", async () => {
    const legacyMessages = [
      { id: "l1", role: "user", content: "Quiet compact micro-ATX build, no RGB" },
      {
        id: "l2",
        role: "assistant",
        content:
          "| Component | Part | Price |\n| --- | --- | --- |\n| CPU | Ryzen 5 5600 | ₹13,490 |\n| GPU | RTX 4060 8GB | ₹31,500 |\n| Motherboard | MSI B550M | ₹9,450 |"
      }
    ];
    const response = await saveViaApi("legacy-1", legacyMessages as never, 1);
    expect(response.status).toBe(200);

    const loaded = (await (await loadViaApi("legacy-1")).json()) as { session: { messages: unknown[] } };
    const reloaded = loaded.session.messages as ChatUIMessage[];

    const versions = findAllBuildVersions(reloaded, "INR");
    const markup = renderToStaticMarkup(<BuildCard versions={versions} inSidePanel />);
    const text = visibleText(markup);
    // It must render, and it must be labelled as text-derived rather than presented
    // as a validated build it never was.
    expect(text).toContain("Ryzen 5 5600");
    expect(text).toContain("Not validated — from the assistant's text");
  });
});
