/**
 * src/lib/mcp/server.ts
 *
 * PCBuildSage as an MCP server. Registers the same tools the chat engine uses
 * (src/lib/tools) through a thin adapter, so MCP clients and the web chat share
 * one implementation. One server per MCP session: the session owns the tool
 * registry's turn store, which carries validate_build results over to
 * present_build and supplies the snapshots the build card renders.
 *
 * Tools register on McpServer with each AI SDK schema wrapped as Standard
 * Schema (standard-schema.ts), so the advertised JSON Schema and the lenient
 * validation are the chat's own. present_build is an MCP App tool: it links
 * the build card UI resource (build-card.ts) and adds `cards` to its result.
 */
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { Tool } from "ai";
import { createToolRegistry, createTurnValidationStore, normalizeLabel, type TurnValidationStore } from "@/lib/tools";
import type { AppConfig } from "@/types";
import { BUILD_CARD_URI, buildCardHtml } from "./build-card";
import { resolveAiSchema, toStandardSchema } from "./standard-schema";

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

/** Adds each presented build's validated snapshot, which is what the card draws. */
function withCards(output: unknown, store: TurnValidationStore): unknown {
  const result = output as { presented?: boolean; builds?: Array<{ label: string; notes?: string }> };
  if (!result?.presented || !Array.isArray(result.builds)) return output;
  const cards = result.builds.map((build) => ({
    label: build.label,
    ...(build.notes ? { notes: build.notes } : {}),
    snapshot: store.get(normalizeLabel(build.label))?.snapshot
  }));
  return { ...result, cards };
}

/** Builds an MCP server exposing the chat tool registry for one session. */
export async function createPcBuildSageMcpServer(config: AppConfig): Promise<McpServer> {
  const server = new McpServer(MCP_SERVER_INFO);
  const turnStore = createTurnValidationStore();
  const registry = createToolRegistry(config, { turnStore }) as Record<string, Tool>;

  for (const [name, chatTool] of Object.entries(registry)) {
    if (CHAT_ONLY_TOOLS.has(name) || !chatTool.execute) continue;
    const execute = chatTool.execute;
    const toolConfig = {
      // AI SDK v7 descriptions may be functions of the call context; ours are strings.
      description: typeof chatTool.description === "function" ? chatTool.description({ context: {} }) : chatTool.description,
      inputSchema: toStandardSchema(await resolveAiSchema(chatTool.inputSchema))
    };
    const callback = async (args: unknown, ctx: { mcpReq: { id: string | number; signal: AbortSignal } }) => {
      const output = await execute(args, {
        toolCallId: String(ctx.mcpReq.id),
        messages: [],
        abortSignal: ctx.mcpReq.signal,
        context: {}
      });
      return toCallToolResult(name === "present_build" ? withCards(output, turnStore) : output);
    };
    if (name === "present_build") {
      registerAppTool(server, name, { ...toolConfig, _meta: { ui: { resourceUri: BUILD_CARD_URI } } }, callback);
    } else {
      server.registerTool(name, toolConfig, callback);
    }
  }

  registerAppResource(server, "PCBuildSage build card", BUILD_CARD_URI, { description: "Parts, prices, retailer links and compatibility checks for presented builds" }, async () => ({
    contents: [{ uri: BUILD_CARD_URI, mimeType: RESOURCE_MIME_TYPE, text: buildCardHtml() }]
  }));

  return server;
}
