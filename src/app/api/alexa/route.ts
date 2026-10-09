/**
 * src/app/api/alexa/route.ts
 *
 * POST /api/alexa: the voice simulator's chat endpoint. It takes exactly what
 * POST /api/chat takes and returns the same AI SDK UI message stream (shared
 * handler), so the page uses useChat unchanged. The only differences: tools
 * come from an MCP client connected to /api/mcp (one MCP session per chat
 * sessionId) instead of createToolRegistry, and the system prompt carries
 * the voice addendum.
 */
import { createChatPostHandler, sanitizeErrorMessage } from "../_lib/chat-handler";
import {
  ALEXA_VOICE_ADDENDUM,
  getAlexaSessions,
  McpUnavailableError,
  pickForwardHeaders,
  resolveMcpUrl
} from "@/lib/alexa/mcp-tools";

export const runtime = "nodejs";

export const POST = createChatPostHandler({
  label: "alexa",
  async overrides(request, body) {
    try {
      const tools = await getAlexaSessions().getTools({
        chatSessionId: body.sessionId,
        mcpUrl: resolveMcpUrl(request.url),
        headers: pickForwardHeaders(request.headers)
      });
      return { tools, systemPromptSuffix: ALEXA_VOICE_ADDENDUM };
    } catch (error) {
      // MCP unreachable (server down, hosted-demo 403, ...): run the turn
      // with no tools and answer in text. Never a fake card.
      const safeMsg = sanitizeErrorMessage(error instanceof McpUnavailableError ? error : new McpUnavailableError(String(error)), request.headers);
      console.error("POST /api/alexa: MCP unavailable, text-only turn:", safeMsg);
      return { tools: {}, systemPromptSuffix: ALEXA_VOICE_ADDENDUM };
    }
  }
});
