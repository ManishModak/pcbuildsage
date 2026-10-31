/**
 * src/lib/alexa/mcp-tools.ts
 *
 * Track B (voice-agent backend): builds the AI SDK tool set for
 * POST /api/alexa from an MCP client connected to /api/mcp — never from
 * createToolRegistry. The web-chat path (streamChat defaults) is untouched.
 *
 * Design notes:
 * - execute() returns the FULL MCP CallToolResult (content + structuredContent)
 *   so the UI-stream present_build part carries structuredContent.cards per
 *   CONTRACT section 3. toModelOutput() is a separate, smaller model view:
 *   validate_build/search_products mirror the chat trims, present_build drops
 *   `cards` (snapshots) — client-side only, the MCP server output is unchanged.
 * - Tool errors from the server (CallToolResult with isError) are thrown, so a
 *   failed call becomes a tool-error result the model reads — never a fake card.
 * - One MCP session per chat sessionId (in-memory map). A stale/evicted server
 *   session is detected from the call failure, replaced with a fresh session,
 *   and the call is retried once; if the retry also fails the error propagates
 *   and the model answers in text.
 */

import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult
} from "@modelcontextprotocol/client";
import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { toModelValidateOutput } from "@/lib/tools/validate-build";
import { toModelSearchResult } from "@/lib/catalog/compact";

/** Fixed env name per CONTRACT section 4. Read at request time. */
export const MCP_URL_ENV = "PCBUILDSAGE_MCP_URL";

/**
 * Voice style, placed first in the system prompt: the general prompt asks for
 * full explanations, and small local models follow the bulk of the prompt
 * unless these rules say they win. The page also trims what it speaks.
 */
export const ALEXA_VOICE_RULES =
  "VOICE MODE. These rules override any other guidance about answer length or format. " +
  "Your text reply is read aloud by a voice assistant: at most two short sentences, under 40 words, " +
  "plain words, no markdown, lists, tables or headings. The build card already shows every part, " +
  "price and check, so never list parts or prices in the reply; name at most the key part and the total. " +
  "When there is a real choice, end with one short question (e.g. 'Want me to swap the GPU for something cheaper?'). " +
  "Keep tool use lean: search only what the build needs, then validate and present.";

/** Closing reminder after the long general prompt (recency helps small models). */
export const ALEXA_VOICE_REMINDER = "Remember VOICE MODE: two short spoken sentences, no lists or markdown.";

/** Idle TTL for one MCP session per conversation; matches the server side. */
export const ALEXA_MCP_SESSION_TTL_MS = 30 * 60_000;
/** Single-use sessions (requests without a chat sessionId) die fast. */
const EPHEMERAL_SESSION_TTL_MS = 60_000;
const MAX_SESSIONS = 100;

/** MCP endpoint: same origin as the incoming request, unless overridden. */
export function resolveMcpUrl(requestUrl: string): string {
  const override = process.env[MCP_URL_ENV]?.trim();
  if (override) return override;
  return new URL("/api/mcp", requestUrl).toString();
}

/**
 * Credential forwarding (CONTRACT section 6): every x-pcbuildsage-* header
 * (config + BYOK keys) plus every x-*-api-key header. Nothing else — no
 * cookies, no authorization header, no keys in bodies or logs.
 */
export function pickForwardHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("x-pcbuildsage-")) {
      out[lower] = value;
    } else if (lower.startsWith("x-") && lower.endsWith("-api-key")) {
      out[lower] = value;
    }
  });
  return out;
}

/**
 * Headers for the MCP connection: forwarded credentials plus the chat's own
 * config. /api/mcp builds its config from headers only, while the page sends
 * its settings (LLM chains, research, search) in the request body, so without
 * this MCP tools would run on server defaults. Body config wins over a header
 * config, as in buildAppConfig; compactContext is chat history, not config.
 */
export function mcpRequestHeaders(headers: Headers, bodyConfig: unknown): Record<string, string> {
  const out = pickForwardHeaders(headers);
  if (!bodyConfig || typeof bodyConfig !== "object" || Array.isArray(bodyConfig)) return out;
  let headerConfig: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(out["x-pcbuildsage-config"] ?? "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) headerConfig = parsed as Record<string, unknown>;
  } catch {
    // An unparsable incoming header is replaced by the body config.
  }
  const config: Record<string, unknown> = { ...headerConfig, ...(bodyConfig as Record<string, unknown>) };
  delete config.compactContext;
  out["x-pcbuildsage-config"] = JSON.stringify(config);
  return out;
}

/** True when the MCP call failed because the server-side session is gone. */
export function isStaleSessionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  if (record.status === 404 || record.statusCode === 404) return true;
  if (record.code === -32001) return true;
  const message =
    error instanceof Error
      ? error.message
      : typeof record.message === "string"
        ? record.message
        : "";
  return /session not found|session expired|invalid session|unknown session|no session/i.test(message);
}

/** Thrown when no MCP session can be established (server down, 403, ...). */
export class McpUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "McpUnavailableError";
  }
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Minimal client surface the adapter needs; injectable for tests. */
export interface McpClientLike {
  listTools(): Promise<{ tools: McpToolDefinition[] }>;
  callTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<CallToolResult>;
  close(): Promise<void>;
}

export type McpConnector = (url: string, headers: Record<string, string>) => Promise<McpClientLike>;

async function defaultConnector(url: string, headers: Record<string, string>): Promise<McpClientLike> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers }
  });
  const client = new Client({ name: "pcbuildsage-alexa", version: "0.1.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw new McpUnavailableError(`MCP connect failed (${url}): ${messageOf(error)}`, { cause: error });
  }
  return {
    listTools: () => client.listTools(),
    callTool: (name, args, options) =>
      client.callTool({ name, arguments: args }, options?.signal ? { signal: options.signal } : undefined),
    close: () => client.close()
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The domain object inside a CallToolResult: structuredContent, else parsed text. */
export function mcpDomainOutput(result: CallToolResult): unknown {
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (structured !== null && structured !== undefined && typeof structured === "object") {
    return structured;
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first?.type === "text" && typeof first.text === "string") {
    try {
      return JSON.parse(first.text) as unknown;
    } catch {
      return first.text;
    }
  }
  return result;
}

/**
 * Model view of an MCP tool result. execute() output (the UI-stream part) is
 * always the full CallToolResult; this only shapes what the model reads back.
 */
export function mcpModelOutput(toolName: string, input: unknown, output: CallToolResult): { type: "json"; value: unknown } {
  const domain = mcpDomainOutput(output);
  if (toolName === "validate_build") {
    return { type: "json", value: toModelValidateOutput(domain) };
  }
  if (toolName === "search_products") {
    const value = toModelSearchResult(
      domain as Parameters<typeof toModelSearchResult>[0],
      input as { category?: string }
    ) as Record<string, unknown>;
    const nearest = (domain as Record<string, unknown> | null)?.nearest_match as
      | { id?: unknown }
      | undefined;
    if (nearest && typeof nearest.id === "string") {
      value.nearest_match = { ...nearest, id: nearest.id.slice(0, 10) };
    }
    return { type: "json", value };
  }
  if (toolName === "present_build" && domain && typeof domain === "object" && !Array.isArray(domain)) {
    // Cards carry full snapshots for the UI; the model only needs the verdict.
    const verdict = { ...(domain as Record<string, unknown>) };
    delete verdict.cards;
    return { type: "json", value: verdict };
  }
  return { type: "json", value: domain };
}

function mcpToolError(toolName: string, result: CallToolResult): Error {
  const domain = mcpDomainOutput(result);
  const detail =
    domain && typeof domain === "object" && "error" in (domain as Record<string, unknown>)
      ? String((domain as Record<string, unknown>).error)
      : (() => {
          try {
            return JSON.stringify(domain).slice(0, 300);
          } catch {
            return "unknown tool error";
          }
        })();
  return new Error(`Tool '${toolName}' failed: ${detail}`);
}

function asJsonSchema(inputSchema: unknown): Record<string, unknown> {
  if (inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)) {
    const schema = inputSchema as Record<string, unknown>;
    return {
      ...(schema as object),
      type: "object",
      properties:
        schema.properties && typeof schema.properties === "object"
          ? (schema.properties as Record<string, unknown>)
          : {}
    };
  }
  return { type: "object", properties: {} };
}

interface SessionEntry {
  connection: McpClientLike;
  tools: ToolSet;
  mcpUrl: string;
  headers: Record<string, string>;
  lastActive: number;
  ephemeral: boolean;
}

function headersEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/**
 * One MCP session per chat sessionId. Owns ToolSet construction so every
 * execute() call routes through the session store (stale retry included).
 */
export class AlexaMcpSessions {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly connect: McpConnector;

  constructor(connect: McpConnector = defaultConnector) {
    this.connect = connect;
  }

  /** ToolSet backed by the chat session's MCP session (or a single-use one). */
  async getTools(options: { chatSessionId?: string; mcpUrl: string; headers: Record<string, string> }): Promise<ToolSet> {
    const { chatSessionId, mcpUrl, headers } = options;
    this.sweep();
    const ephemeral = !chatSessionId;
    const key = ephemeral ? `ephemeral:${crypto.randomUUID()}` : `chat:${chatSessionId}`;
    if (!ephemeral) {
      const existing = this.sessions.get(key);
      if (existing) {
        if (existing.mcpUrl === mcpUrl && headersEqual(existing.headers, headers)) {
          existing.lastActive = Date.now();
          return existing.tools;
        }
        // Endpoint or credentials changed: drop the old session, start fresh.
        await this.evict(key, existing);
      }
    }
    const entry = await this.createEntry(key, mcpUrl, headers, ephemeral);
    return entry.tools;
  }

  /** Number of cached sessions (tests + diagnostics). */
  get size(): number {
    return this.sessions.size;
  }

  async closeAll(): Promise<void> {
    const entries = [...this.sessions.entries()];
    this.sessions.clear();
    await Promise.all(entries.map(([, entry]) => entry.connection.close().catch(() => undefined)));
  }

  private async createEntry(
    key: string,
    mcpUrl: string,
    headers: Record<string, string>,
    ephemeral: boolean
  ): Promise<SessionEntry> {
    let connection: McpClientLike;
    try {
      connection = await this.connect(mcpUrl, headers);
    } catch (error) {
      if (error instanceof McpUnavailableError) throw error;
      throw new McpUnavailableError(`MCP connect failed (${mcpUrl}): ${messageOf(error)}`, { cause: error });
    }
    let defs: McpToolDefinition[];
    try {
      defs = (await connection.listTools()).tools;
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw new McpUnavailableError(`MCP listTools failed (${mcpUrl}): ${messageOf(error)}`, { cause: error });
    }
    const tools: ToolSet = {};
    for (const def of defs) {
      const toolName = def.name;
      tools[toolName] = dynamicTool({
        description: def.description ?? `MCP tool ${toolName}`,
        inputSchema: jsonSchema(asJsonSchema(def.inputSchema) as never),
        execute: (async (args: unknown, execOptions?: { abortSignal?: AbortSignal }) => {
          const params = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
          return this.callWithRetry(key, mcpUrl, headers, ephemeral, toolName, params, execOptions?.abortSignal);
        }) as never,
        toModelOutput: (({ input, output }: { input: unknown; output: unknown }) =>
          mcpModelOutput(toolName, input, output as CallToolResult)) as never
      });
    }
    const entry: SessionEntry = { connection, tools, mcpUrl, headers, lastActive: Date.now(), ephemeral };
    this.sessions.set(key, entry);
    this.enforceCap();
    return entry;
  }

  /** Calls the tool, replacing a stale session and retrying once. */
  private async callWithRetry(
    key: string,
    mcpUrl: string,
    headers: Record<string, string>,
    ephemeral: boolean,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<CallToolResult> {
    const entry = this.sessions.get(key);
    if (!entry) {
      // Evicted between turns: start a fresh session and run once (no retry left).
      const fresh = await this.createEntry(key, mcpUrl, headers, ephemeral);
      return this.runCall(fresh, toolName, args, signal);
    }
    try {
      return await this.runCall(entry, toolName, args, signal);
    } catch (error) {
      if (!isStaleSessionError(error)) throw error;
      await this.evict(key, entry);
      const fresh = await this.createEntry(key, mcpUrl, headers, ephemeral);
      // One retry on the fresh session; its failure propagates and the model
      // answers in text (a retry that still cannot present is never faked).
      return await this.runCall(fresh, toolName, args, signal);
    }
  }

  private async runCall(
    entry: SessionEntry,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<CallToolResult> {
    entry.lastActive = Date.now();
    const result = await entry.connection.callTool(toolName, args, signal ? { signal } : undefined);
    if (result.isError) throw mcpToolError(toolName, result);
    return result;
  }

  private async evict(key: string, entry: SessionEntry): Promise<void> {
    this.sessions.delete(key);
    await entry.connection.close().catch(() => undefined);
  }

  private enforceCap(): void {
    if (this.sessions.size <= MAX_SESSIONS) return;
    const byAge = [...this.sessions.entries()].sort((a, b) => a[1].lastActive - b[1].lastActive);
    for (const [id, entry] of byAge.slice(0, this.sessions.size - MAX_SESSIONS)) {
      void this.evict(id, entry);
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of [...this.sessions]) {
      const ttl = entry.ephemeral ? EPHEMERAL_SESSION_TTL_MS : ALEXA_MCP_SESSION_TTL_MS;
      if (now - entry.lastActive >= ttl) void this.evict(id, entry);
    }
  }
}

let sharedSessions: AlexaMcpSessions | undefined;

/** Process-wide session map used by POST /api/alexa. */
export function getAlexaSessions(): AlexaMcpSessions {
  sharedSessions ??= new AlexaMcpSessions();
  return sharedSessions;
}
