/**
 * src/lib/mcp/server.ts
 *
 * PCBuildSage as an MCP server. Registers the same tools the chat engine uses
 * (src/lib/tools) through a thin adapter, so MCP clients and the web chat share
 * one implementation. One server per MCP session: the tool registry's turn
 * store then carries a session's validate_build results over to present_build.
 *
 * Uses the SDK's low-level Server rather than McpServer (v2): McpServer.registerTool
 * only takes Standard Schema with JSON (a `~standard` interface), which the AI SDK
 * schemas don't implement, and fromJsonSchema would validate strictly, losing the
 * lenient coercion in lenient-input.ts. Each tool's own AI SDK schema supplies
 * both the advertised JSON Schema and the argument validation.
 */
import { Server } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { asSchema, type Tool } from "ai";
import { createToolRegistry } from "@/lib/tools";
import type { AppConfig } from "@/types";

/** Chat-UI-only tools with no meaning for other MCP clients. */
const CHAT_ONLY_TOOLS = new Set(["suggest_followups"]);

export const MCP_SERVER_INFO = { name: "pcbuildsage", version: "0.1.0" } as const;

/** Wraps one chat tool's output as an MCP tool result (JSON text plus structured content). */
export function toCallToolResult(output: unknown): CallToolResult {
  const structured = output !== null && typeof output === "object" && !Array.isArray(output)
    ? (output as Record<string, unknown>)
    : undefined;
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    ...(structured ? { structuredContent: structured } : {})
  };
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Builds an MCP server exposing the chat tool registry for one session. */
export function createPcBuildSageMcpServer(config: AppConfig): Server {
  const server = new Server(MCP_SERVER_INFO, { capabilities: { tools: {} } });
  const tools = new Map(
    Object.entries(createToolRegistry(config) as Record<string, Tool>)
      .filter(([name, chatTool]) => !CHAT_ONLY_TOOLS.has(name) && chatTool.execute)
      .map(([name, chatTool]) => [name, { chatTool, schema: asSchema(chatTool.inputSchema) }])
  );

  server.setRequestHandler('tools/list', async () => ({
    tools: await Promise.all(
      [...tools].map(async ([name, { chatTool, schema }]) => ({
        name,
        // AI SDK v7 descriptions may be functions of the call context; ours are strings.
        description: typeof chatTool.description === "function" ? chatTool.description({ context: {} }) : chatTool.description,
        inputSchema: (await schema.jsonSchema) as { type: "object"; [key: string]: unknown }
      }))
    )
  }));

  server.setRequestHandler('tools/call', async (request, ctx) => {
    const entry = tools.get(request.params.name);
    if (!entry) return errorResult(`Unknown tool: ${request.params.name}`);
    const args = request.params.arguments ?? {};
    const parsed = entry.schema.validate ? await entry.schema.validate(args) : { success: true as const, value: args };
    if (!parsed.success) return errorResult(parsed.error.message);
    try {
      const output = await entry.chatTool.execute!(parsed.value, {
        toolCallId: String(ctx.mcpReq.id),
        messages: [],
        abortSignal: ctx.mcpReq.signal,
        context: {}
      });
      return toCallToolResult(output);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  return server;
}
