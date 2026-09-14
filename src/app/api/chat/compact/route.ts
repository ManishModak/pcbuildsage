import { z } from "zod";
import { convertToModelMessages, type UIMessage } from "ai";
import { buildAppConfig, UnsafeConfigError } from "../../_lib/credentials";
import { badRequest, readJson, serverError } from "../../_lib/responses";
import { buildSystemPrompt } from "@/lib/llm/chat-engine";
import { compactConversation } from "@/lib/llm/compaction";
import { getModelContextLimit } from "@/lib/llm/context-budget";
import { getSession, saveSession, isSessionCompacting } from "@/lib/sessions";
import type { BuildSnapshot } from "@/lib/catalog/build-snapshot";

export const runtime = "nodejs";

const compactPartSchema = z.object({
  type: z.string(),
  text: z.string().optional()
}).passthrough();

const compactMessageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string().optional(),
  parts: z.array(compactPartSchema).optional()
});

const compactRequestSchema = z.object({
  messages: z.array(compactMessageSchema),
  sessionId: z.string().optional(),
  config: z.unknown().optional(),
  force: z.boolean().optional()
});

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");
  const compacting = sessionId ? isSessionCompacting(sessionId) : false;
  return Response.json({ compacting });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = compactRequestSchema.parse(await readJson(request));
    const config = buildAppConfig(request.headers, body.config ?? {});
    const systemPrompt = buildSystemPrompt(config);

    const activeEntry = config.llm.roles.chat[0];
    const contextLimit = getModelContextLimit(activeEntry);

    const session = body.sessionId ? getSession(body.sessionId) : null;
    const sessionSnapshot = (session?.build_state as { snapshot?: BuildSnapshot } | null)?.snapshot;

    const uiMessages: UIMessage[] = body.messages.map((m) => ({
      id: m.id ?? crypto.randomUUID(),
      role: m.role as "user" | "assistant" | "system",
      content: m.content ?? "",
      parts: (m.parts ?? []) as UIMessage["parts"]
    }));

    const modelMessages = await convertToModelMessages(uiMessages);

    const result = await compactConversation({
      chain: config.llm.roles.chat,
      systemPrompt,
      messages: modelMessages,
      snapshot: sessionSnapshot,
      contextLimit,
      force: body.force ?? true,
      abortSignal: request.signal
    });

    if (result.compacted && body.sessionId) {
      const current = getSession(body.sessionId);
      const nextRev = (current?.revision ?? 0) + 1;
      const lastMsgId = body.messages.at(-1)?.id;
      saveSession({
        id: body.sessionId,
        revision: nextRev,
        compactContext: {
          messages: result.messages,
          boundaryMessageId: lastMsgId,
          snapshot: sessionSnapshot
        }
      });
    }

    return Response.json({
      success: true,
      compacted: result.compacted,
      handoffText: result.compacted ? result.handoffText : undefined,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      reason: !result.compacted ? result.reason : undefined
    });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof UnsafeConfigError) {
      return badRequest(error);
    }
    return serverError(error instanceof Error ? error : new Error(String(error)));
  }
}
