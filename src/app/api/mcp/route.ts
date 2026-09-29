/**
 * src/app/api/mcp/route.ts
 *
 * MCP endpoint (Streamable HTTP, spec 2025-11-25). An initialize request
 * without a session ID starts a session with its own server and tool state;
 * later requests carry the Mcp-Session-Id header. Sessions live in memory.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildAppConfig } from "@/app/api/_lib/credentials";
import { createPcBuildSageMcpServer } from "@/lib/mcp/server";

export const runtime = "nodejs";

const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

async function handle(request: Request): Promise<Response> {
  const sessionId = request.headers.get("mcp-session-id");
  const existing = sessionId ? sessions.get(sessionId) : undefined;
  if (existing) return existing.handleRequest(request);
  if (sessionId) {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Session not found. Start a new session." }, id: null },
      { status: 404 }
    );
  }

  const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, transport);
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
    }
  });
  const server = createPcBuildSageMcpServer(buildAppConfig(request.headers));
  await server.connect(transport);
  return transport.handleRequest(request);
}

export { handle as GET, handle as POST, handle as DELETE };
