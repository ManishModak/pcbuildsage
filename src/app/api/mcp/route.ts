/**
 * src/app/api/mcp/route.ts
 *
 * MCP endpoint (Streamable HTTP, spec 2025-11-25). An initialize request
 * without a session ID starts a session with its own server and tool state;
 * later requests carry the Mcp-Session-Id header. Sessions live in memory,
 * capped at MCP_MAX_SESSIONS with MCP_SESSION_IDLE_MS idle eviction
 * (see session-store.ts); evicted transports are closed.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { buildAppConfig } from "@/app/api/_lib/credentials";
import { createPcBuildSageMcpServer } from "@/lib/mcp/server";
import { evictSessions, type SessionEntry } from "@/lib/mcp/session-store";

export const runtime = "nodejs";

const sessions = new Map<string, SessionEntry<WebStandardStreamableHTTPServerTransport>>();

let sweepTimer: ReturnType<typeof setInterval> | undefined;

/** Idle sweep every minute; unref'd so it never holds the process open (tests, build). */
function ensureSweepTimer(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    void evictSessions(sessions);
  }, 60_000);
  sweepTimer.unref?.();
}

async function handle(request: Request): Promise<Response> {
  ensureSweepTimer();
  const sessionId = request.headers.get("mcp-session-id");
  const existing = sessionId ? sessions.get(sessionId) : undefined;
  if (existing) {
    existing.lastActive = Date.now();
    return existing.transport.handleRequest(request);
  }
  if (sessionId) {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Session not found. Start a new session." }, id: null },
      { status: 404 }
    );
  }

  const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, lastActive: Date.now() });
      // Enforce the cap now that the new session is stored (oldest-first).
      void evictSessions(sessions);
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
    }
  });
  const server = await createPcBuildSageMcpServer(buildAppConfig(request.headers));
  await server.connect(transport);
  return transport.handleRequest(request);
}

export { handle as GET, handle as POST, handle as DELETE };
