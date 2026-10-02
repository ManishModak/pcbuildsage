/**
 * Track B: tests for the alexa MCP-client adapter (src/lib/alexa/mcp-tools.ts).
 *
 * - Tool provenance: the ToolSet genuinely comes from an MCP server
 *   (in-memory transport + the real server), minus chat-UI-only tools.
 * - Pass-through: present_build execute() output is the FULL CallToolResult
 *   with structuredContent.cards (CONTRACT section 3), via a real
 *   validate -> present round trip against the sample catalog.
 * - Stale sessions: retry-once on a fresh session, then propagate (text
 *   fallback happens in the caller; never a fake card).
 * - Model views are trimmed client-side; the MCP server output is untouched.
 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { resolveConfig } from "../../config";
import { createPcBuildSageMcpServer } from "../../mcp/server";
import {
  AlexaMcpSessions,
  isStaleSessionError,
  MCP_URL_ENV,
  mcpModelOutput,
  pickForwardHeaders,
  resolveMcpUrl,
  type McpClientLike,
  type McpConnector,
  type McpToolDefinition
} from "../mcp-tools";

const SAMPLE_DB = path.resolve(__dirname, "../../../../data/products-sample.db");

const sessionsToClose: AlexaMcpSessions[] = [];
afterEach(async () => {
  while (sessionsToClose.length > 0) {
    await sessionsToClose.pop()!.closeAll();
  }
});

function track(sessions: AlexaMcpSessions): AlexaMcpSessions {
  sessionsToClose.push(sessions);
  return sessions;
}

/** Connector backed by the real MCP server over an in-memory transport. */
async function inMemoryConnector(): Promise<{ connector: McpConnector; calls: { count: number } }> {
  const server = await createPcBuildSageMcpServer(
    resolveConfig({ dbPath: SAMPLE_DB, countryCode: "IN", currency: "INR", tier2Enabled: false })
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-alexa", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const calls = { count: 0 };
  const connector: McpConnector = async () => {
    calls.count += 1;
    const connection: McpClientLike = {
      listTools: () => client.listTools(),
      callTool: (name, args, options) =>
        client.callTool({ name, arguments: args }, options?.signal ? { signal: options.signal } : undefined),
      close: () => client.close()
    };
    return connection;
  };
  return { connector, calls };
}

function cannedConnector(
  defs: McpToolDefinition[],
  callTool: McpClientLike["callTool"]
): { connector: McpConnector; calls: { count: number; headers: Array<Record<string, string>> } } {
  const calls = { count: 0, headers: [] as Array<Record<string, string>> };
  const connector: McpConnector = async (_url, headers) => {
    calls.count += 1;
    calls.headers.push(headers);
    return { listTools: async () => ({ tools: defs }), callTool, close: async () => undefined };
  };
  return { connector, calls };
}

type ExecTool = { execute?: (input: unknown, options: never) => Promise<unknown> };
type ModelTool = {
  toModelOutput?: (options: { toolCallId: string; input: unknown; output: unknown }) => Promise<unknown> | unknown;
};

const EXEC_CTX = { toolCallId: "t1", messages: [] } as never;

function fullPresentResult(): CallToolResult {
  const structured = {
    presented: true,
    builds: [{ label: "Within budget", product_ids: ["da6670a41d"] }],
    cards: [
      {
        label: "Within budget",
        snapshot: {
          label: "Within budget",
          total: 100000,
          currency: "INR",
          components: [
            { category: "cpu", product_id: "da6670a41d06377759be1c70e28f32230239c099", name: "CPU", price: 55000 },
            { category: "motherboard", product_id: "b2f9d25f2b06377759be1c70e28f32230239c200", name: "Board", price: 45000 }
          ]
        }
      }
    ]
  };
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured
  } as CallToolResult;
}

describe("resolveMcpUrl", () => {
  it("defaults to same-origin /api/mcp", () => {
    expect(resolveMcpUrl("http://localhost:3000/api/alexa")).toBe("http://localhost:3000/api/mcp");
    expect(resolveMcpUrl("https://example.com:4443/api/alexa?x=1")).toBe("https://example.com:4443/api/mcp");
  });

  it("honours the PCBUILDSAGE_MCP_URL override, read at request time", () => {
    const prev = process.env[MCP_URL_ENV];
    try {
      process.env[MCP_URL_ENV] = "http://127.0.0.1:4000/api/mcp";
      expect(resolveMcpUrl("http://localhost:3000/api/alexa")).toBe("http://127.0.0.1:4000/api/mcp");
      process.env[MCP_URL_ENV] = "   ";
      expect(resolveMcpUrl("http://localhost:3000/api/alexa")).toBe("http://localhost:3000/api/mcp");
    } finally {
      if (prev === undefined) delete process.env[MCP_URL_ENV];
      else process.env[MCP_URL_ENV] = prev;
    }
  });
});

describe("pickForwardHeaders", () => {
  it("forwards x-pcbuildsage-* and x-*-api-key, nothing else", () => {
    const headers = new Headers();
    headers.set("x-pcbuildsage-config", '{"a":1}');
    headers.set("x-pcbuildsage-api-key-gemini", "g-key");
    headers.set("x-gemini-api-key", "g-key-2");
    headers.set("x-tavily-api-key", "t-key");
    headers.set("authorization", "Bearer nope");
    headers.set("content-type", "application/json");
    headers.set("x-custom-thing", "nope");
    expect(pickForwardHeaders(headers)).toEqual({
      "x-pcbuildsage-config": '{"a":1}',
      "x-pcbuildsage-api-key-gemini": "g-key",
      "x-gemini-api-key": "g-key-2",
      "x-tavily-api-key": "t-key"
    });
  });
});

describe("isStaleSessionError", () => {
  it.each([
    [new Error("Session not found. Start a new session."), true],
    [new Error("MCP session expired"), true],
    [{ status: 404, message: "gone" }, true],
    [{ statusCode: 404 }, true],
    [{ code: -32001, message: "Session not found" }, true],
    [new Error("boom"), false],
    [new Error("Tool 'x' failed: nope"), false],
    [null, false],
    ["Session not found", false]
  ])("%o -> %s", (error, expected) => {
    expect(isStaleSessionError(error)).toBe(expected);
  });
});

describe("ToolSet provenance (real MCP server, in-memory transport)", () => {
  it("exposes the MCP tools minus chat-UI-only tools", async () => {
    const { connector } = await inMemoryConnector();
    const sessions = track(new AlexaMcpSessions(connector));
    const tools = await sessions.getTools({ chatSessionId: "s1", mcpUrl: "inmemory:", headers: {} });
    expect(Object.keys(tools).sort()).toEqual(["list_models", "present_build", "search_products", "validate_build"]);
  });

  it("executes through the MCP session: present refuses unvalidated labels", async () => {
    const { connector } = await inMemoryConnector();
    const sessions = track(new AlexaMcpSessions(connector));
    const tools = await sessions.getTools({ chatSessionId: "s1", mcpUrl: "inmemory:", headers: {} });
    const out = (await (tools.present_build as ExecTool).execute!({ builds: [{ label: "Nope" }] }, EXEC_CTX)) as unknown as {
      structuredContent: { presented: boolean; valid_labels: string[] };
    };
    expect(out.structuredContent.presented).toBe(false);
    expect(out.structuredContent.valid_labels).toEqual([]);
  });

  it("validate -> present round trip keeps full snapshots in structuredContent.cards", async () => {
    const { connector } = await inMemoryConnector();
    const sessions = track(new AlexaMcpSessions(connector));
    const tools = await sessions.getTools({ chatSessionId: "s1", mcpUrl: "inmemory:", headers: {} });
    const validateOut = (await (tools.validate_build as ExecTool).execute!(
      {
        builds: [
          {
            label: "Within budget",
            parts: { cpu: { product_id: "da6670a41d" }, motherboard: { product_id: "b2f9d25f2b" } }
          }
        ]
      },
      EXEC_CTX
    )) as unknown as CallToolResult;
    expect(validateOut.structuredContent).toMatchObject({ builds: { "Within budget": { valid: true } } });

    const presentOut = (await (tools.present_build as ExecTool).execute!(
      { builds: [{ label: "Within budget" }] },
      EXEC_CTX
    )) as unknown as CallToolResult;
    // Full CallToolResult shape: text content + structured content.
    expect(Array.isArray(presentOut.content)).toBe(true);
    expect(presentOut.content[0]).toMatchObject({ type: "text" });
    const structured = presentOut.structuredContent as {
      presented: boolean;
      builds: Array<{ label: string; product_ids: string[] }>;
      cards: Array<{ label: string; snapshot: { components: unknown[]; total: number } }>;
    };
    expect(structured.presented).toBe(true);
    expect(structured.builds).toMatchObject([{ label: "Within budget" }]);
    expect(structured.cards).toHaveLength(1);
    expect(structured.cards[0].label).toBe("Within budget");
    expect(structured.cards[0].snapshot.components.length).toBeGreaterThan(0);
    expect(structured.cards[0].snapshot.total).toBeGreaterThan(0);
    // The text content is the same JSON (CONTRACT section 3 fallback).
    expect(JSON.parse((presentOut.content[0] as { text: string }).text)).toMatchObject({ presented: true });
  });
});

describe("session affinity", () => {
  const defs: McpToolDefinition[] = [{ name: "ping", description: "pong", inputSchema: { type: "object", properties: {} } }];
  const ok: McpClientLike["callTool"] = async () => ({ content: [{ type: "text", text: "{}" }] }) as CallToolResult;

  it("reuses one MCP session per chat sessionId", async () => {
    const { connector, calls } = cannedConnector(defs, ok);
    const sessions = track(new AlexaMcpSessions(connector));
    await sessions.getTools({ chatSessionId: "s1", mcpUrl: "mcp:", headers: {} });
    await sessions.getTools({ chatSessionId: "s1", mcpUrl: "mcp:", headers: {} });
    await sessions.getTools({ chatSessionId: "s2", mcpUrl: "mcp:", headers: {} });
    expect(calls.count).toBe(2);
    expect(sessions.size).toBe(2);
  });

  it("uses a single-use session per request without a sessionId", async () => {
    const { connector, calls } = cannedConnector(defs, ok);
    const sessions = track(new AlexaMcpSessions(connector));
    await sessions.getTools({ mcpUrl: "mcp:", headers: {} });
    await sessions.getTools({ mcpUrl: "mcp:", headers: {} });
    expect(calls.count).toBe(2);
  });

  it("reconnects when endpoint or credentials change", async () => {
    const { connector, calls } = cannedConnector(defs, ok);
    const sessions = track(new AlexaMcpSessions(connector));
    await sessions.getTools({ chatSessionId: "s1", mcpUrl: "mcp:", headers: { "x-gemini-api-key": "k1" } });
    await sessions.getTools({ chatSessionId: "s1", mcpUrl: "mcp:", headers: { "x-gemini-api-key": "k1" } });
    expect(calls.count).toBe(1);
    await sessions.getTools({ chatSessionId: "s1", mcpUrl: "mcp:", headers: { "x-gemini-api-key": "k2" } });
    expect(calls.count).toBe(2);
  });
});

describe("stale session retry", () => {
  const defs: McpToolDefinition[] = [{ name: "present_build", description: "p", inputSchema: { type: "object", properties: {} } }];

  it("retries the call once on a fresh session", async () => {
    const stale = new Error("Session not found. Start a new session.");
    const success = fullPresentResult();
    let calls = 0;
    const connector: McpConnector = async () => ({
      listTools: async () => ({ tools: defs }),
      callTool: async () => {
        calls += 1;
        if (calls === 1) throw stale;
        return success;
      },
      close: async () => undefined
    });
    // Two connections: initial + one fresh retry.
    let connects = 0;
    const counting: McpConnector = async (url, headers) => {
      connects += 1;
      return connector(url, headers);
    };
    const sessions = track(new AlexaMcpSessions(counting));
    const tools = await sessions.getTools({ chatSessionId: "s1", mcpUrl: "mcp:", headers: {} });
    const out = await (tools.present_build as ExecTool).execute!({ builds: [] }, EXEC_CTX);
    expect(out).toBe(success);
    expect(connects).toBe(2);
    expect(calls).toBe(2);
  });

  it("propagates when the retry also fails (caller falls back to text)", async () => {
    const stale = new Error("Session not found. Start a new session.");
    const connector: McpConnector = async () => ({
      listTools: async () => ({ tools: defs }),
      callTool: async () => {
        throw stale;
      },
      close: async () => undefined
    });
    const sessions = track(new AlexaMcpSessions(connector));
    const tools = await sessions.getTools({ chatSessionId: "s1", mcpUrl: "mcp:", headers: {} });
    await expect((tools.present_build as ExecTool).execute!({ builds: [] }, EXEC_CTX)).rejects.toThrow(/Session not found/);
  });

  it("does not retry non-session errors, and surfaces tool isError as failure", async () => {
    let connects = 0;
    let calls = 0;
    const connector: McpConnector = async () => {
      connects += 1;
      return {
        listTools: async () => ({ tools: defs }),
        callTool: async () => {
          calls += 1;
          throw new Error("boom");
        },
        close: async () => undefined
      };
    };
    const sessions = track(new AlexaMcpSessions(connector));
    const tools = await sessions.getTools({ chatSessionId: "s1", mcpUrl: "mcp:", headers: {} });
    await expect((tools.present_build as ExecTool).execute!({ builds: [] }, EXEC_CTX)).rejects.toThrow("boom");
    expect(connects).toBe(1);
    expect(calls).toBe(1);

    const errConnector: McpConnector = async () => ({
      listTools: async () => ({ tools: defs }),
      callTool: async () =>
        ({ content: [{ type: "text", text: '{"error":"bad args"}' }], structuredContent: { error: "bad args" }, isError: true }) as CallToolResult,
      close: async () => undefined
    });
    const sessions2 = track(new AlexaMcpSessions(errConnector));
    const tools2 = await sessions2.getTools({ chatSessionId: "s1", mcpUrl: "mcp:", headers: {} });
    await expect((tools2.present_build as ExecTool).execute!({ builds: [] }, EXEC_CTX)).rejects.toThrow(/failed/);
  });
});

describe("model views (client-side trim; server output untouched)", () => {
  it("passes the full result to the UI stream but trims the model view", async () => {
    const full = fullPresentResult();
    const { connector } = cannedConnector(
      [{ name: "present_build", description: "p", inputSchema: { type: "object", properties: {} } }],
      async () => full
    );
    const sessions = track(new AlexaMcpSessions(connector));
    const tools = await sessions.getTools({ chatSessionId: "s1", mcpUrl: "mcp:", headers: {} });
    const out = (await (tools.present_build as ExecTool).execute!({ builds: [] }, EXEC_CTX)) as unknown as CallToolResult;
    expect(out).toBe(full);
    expect((out.structuredContent as { cards: unknown[] }).cards).toHaveLength(1);

    const model = (await (tools.present_build as ModelTool).toModelOutput!({
      toolCallId: "t1",
      input: {},
      output: full
    })) as { type: string; value: Record<string, unknown> };
    expect(model.type).toBe("json");
    expect(model.value.presented).toBe(true);
    expect(model.value.builds).toBeDefined();
    expect(model.value).not.toHaveProperty("cards");
  });

  it("trims validate_build product IDs for the model like the chat path", () => {
    const fullId = "da6670a41d06377759be1c70e28f32230239c099";
    const result = {
      content: [{ type: "text", text: "unused" }],
      structuredContent: {
        builds: {
          "Within budget": {
            valid: true,
            issues: [],
            snapshot: { label: "Within budget", components: [{ category: "cpu", product_id: fullId }] }
          }
        }
      }
    } as unknown as CallToolResult;
    const model = mcpModelOutput("validate_build", {}, result) as { value: {
      builds: { "Within budget": { snapshot: { components: Array<{ product_id: string }> } } };
    } };
    expect(model.value.builds["Within budget"].snapshot.components[0].product_id).toHaveLength(10);
  });
});

describe("token cost (3-build turn, full vs model view)", () => {
  function validateFixture(): CallToolResult {
    const builds: Record<string, unknown> = {};
    for (let b = 1; b <= 3; b += 1) {
      const components = [];
      for (let c = 0; c < 8; c += 1) {
        components.push({
          category: `part${c}`,
          product_id: `abcdef${b}0123456789abcdef0123456789abcdef${c}99`,
          name: `Example Part ${c} for build ${b} with a realistic name`,
          price: 10000 + c * 1500,
          retailer: "Example Store",
          url: "https://example.com/product/some-long-slug-for-realism"
        });
      }
      builds[`Build ${b}`] = {
        valid: true,
        issues: [],
        snapshot: { label: `Build ${b}`, total: 120000, currency: "INR", components }
      };
    }
    const structured = { builds };
    return {
      content: [{ type: "text", text: JSON.stringify(structured) }],
      structuredContent: structured
    } as CallToolResult;
  }

  function presentFixture(): CallToolResult {
    const structured = mcpDomainOutputShim();
    return {
      content: [{ type: "text", text: JSON.stringify(structured) }],
      structuredContent: structured
    } as CallToolResult;
  }

  function mcpDomainOutputShim(): Record<string, unknown> {
    const cards = [];
    for (let b = 1; b <= 3; b += 1) {
      const components = [];
      for (let c = 0; c < 8; c += 1) {
        components.push({
          category: `part${c}`,
          product_id: `abcdef${b}0123456789abcdef0123456789abcdef${c}99`,
          name: `Example Part ${c} for build ${b} with a realistic name`,
          price: 10000 + c * 1500,
          retailer: "Example Store",
          url: "https://example.com/product/some-long-slug-for-realism",
          specs: { socket: "AM5", wattage: 750, note: "extra spec payload the card needs" }
        });
      }
      cards.push({ label: `Build ${b}`, snapshot: { label: `Build ${b}`, total: 120000, currency: "INR", components } });
    }
    return {
      presented: true,
      builds: [1, 2, 3].map((b) => ({ label: `Build ${b}`, product_ids: ["abcdef1234"] })),
      cards
    };
  }

  it("measures full vs model-view bytes", () => {
    const approxTokens = (chars: number) => Math.round(chars / 4);
    const validateFull = validateFixture();
    const validateModel = mcpModelOutput("validate_build", {}, validateFull);
    const presentFull = presentFixture();
    const presentModel = mcpModelOutput("present_build", {}, presentFull);

    const fullChars = JSON.stringify(validateFull.structuredContent).length + JSON.stringify(presentFull.structuredContent).length;
    const modelChars = JSON.stringify(validateModel.value).length + JSON.stringify(presentModel.value).length;
    // eslint-disable-next-line no-console
    console.log(
      `alexa token probe: full=${fullChars} chars (~${approxTokens(fullChars)} tok), ` +
        `model-view=${modelChars} chars (~${approxTokens(modelChars)} tok)`
    );
    expect(modelChars).toBeLessThan(fullChars);
  });
});
