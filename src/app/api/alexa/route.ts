/**
 * src/app/api/alexa/route.ts
 *
 * POST /api/alexa: the voice simulator's chat endpoint. It takes exactly what
 * POST /api/chat takes and returns the same AI SDK UI message stream (shared
 * handler), so the page uses useChat unchanged. The only differences: tools
 * come from an MCP client connected to /api/mcp (one MCP session per chat
 * sessionId, running with the chat's own config) instead of
 * createToolRegistry, and the system prompt carries the voice rules.
 */
import { createChatPostHandler, sanitizeErrorMessage } from "../_lib/chat-handler";
import {
  ALEXA_VOICE_REMINDER,
  ALEXA_VOICE_RULES,
  getAlexaSessions,
  McpUnavailableError,
  mcpRequestHeaders,
  resolveMcpUrl
} from "@/lib/alexa/mcp-tools";

export const runtime = "nodejs";

// Voice turns skip local models' thinking: on Ornith 9B that cut a build turn
// from 10+ minutes (5-7k thinking tokens per step) to about 90 seconds.
const VOICE_PROMPT = { systemPromptPrefix: ALEXA_VOICE_RULES, systemPromptSuffix: ALEXA_VOICE_REMINDER, thinking: false };

export const POST = createChatPostHandler({
  label: "alexa",
  async overrides(request, body) {
    try {
      const tools = await getAlexaSessions().getTools({
        chatSessionId: body.sessionId,
        mcpUrl: resolveMcpUrl(request.url),
        headers: mcpRequestHeaders(request.headers, body.config)
      });
      return { tools, ...VOICE_PROMPT };
    } catch (error) {
      // MCP unreachable (server down, hosted-demo 403, ...): run the turn
      // with no tools and answer in text. Never a fake card.
      const safeMsg = sanitizeErrorMessage(error instanceof McpUnavailableError ? error : new McpUnavailableError(String(error)), request.headers);
      console.error("POST /api/alexa: MCP unavailable, text-only turn:", safeMsg);
      return { tools: {}, ...VOICE_PROMPT };
    }
  }
});
