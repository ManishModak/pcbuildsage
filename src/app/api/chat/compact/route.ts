import { z } from "zod";
import { convertToModelMessages, type UIMessage } from "ai";
import { buildAppConfig, UnsafeConfigError } from "../../_lib/credentials";
import { badRequest, readJson, serverError } from "../../_lib/responses";
import { buildSystemPrompt } from "@/lib/llm/chat-engine";
import { compactConversation } from "@/lib/llm/compaction";
import { getModelContextLimit } from "@/lib/llm/context-budget";
import { deriveBuildState } from "@/lib/llm/messages";
import { getSession, saveCompactContext, isSessionCompacting } from "@/lib/sessions";
import type { BuildSnapshot } from "@/lib/catalog/build-snapshot";
import {
  checkChatPayloadSize,
  HOSTED_CHAT_MAX_BODY_BYTES,
  isHostedDemo
} from "@/lib/config/deployment";
function isHosted(): boolean {
  return isHostedDemo();
}

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
  const compacting = (sessionId && !isHosted()) ? isSessionCompacting(sessionId) : false;
  return Response.json({ compacting });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > HOSTED_CHAT_MAX_BODY_BYTES) {
      return Response.json(
        { error: "payload_too_large", message: `Request body exceeds ${HOSTED_CHAT_MAX_BODY_BYTES} bytes.` },
        { status: 413 }
      );
    }
    const rawBody = await readJson(request);
    const sizeCheck = checkChatPayloadSize(rawBody);
    if (!sizeCheck.allowed) {
      return Response.json(
        { error: "payload_too_large", message: sizeCheck.reason ?? "Request body too large." },
        { status: 413 }
      );
    }
    const body = compactRequestSchema.parse(rawBody);
    const config = buildAppConfig(request.headers, body.config ?? {});
    const systemPrompt = buildSystemPrompt(config);

    const activeEntry = config.llm.roles.chat[0];
    const contextLimit = getModelContextLimit(activeEntry);

    const uiMessages: UIMessage[] = body.messages.map((m) => ({
      id: m.id ?? crypto.randomUUID(),
      role: m.role as "user" | "assistant" | "system",
      content: m.content ?? "",
      parts: (m.parts ?? []) as UIMessage["parts"]
    }));

    const session = (!isHosted() && body.sessionId) ? getSession(body.sessionId) : null;
    const sessionSnapshot = (session?.build_state as { snapshot?: BuildSnapshot } | null)?.snapshot ??
      (deriveBuildState(uiMessages)?.snapshot as BuildSnapshot | undefined);

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

    const lastMsgId = body.messages.at(-1)?.id;
    if (result.compacted && body.sessionId && !isHosted()) {
      saveCompactContext(body.sessionId, {
        messages: result.messages,
        boundaryMessageId: lastMsgId,
        snapshot: sessionSnapshot ?? null
      });
    }

    return Response.json({
      success: true,
      compacted: result.compacted,
      handoffText: result.compacted ? result.handoffText : undefined,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      reason: !result.compacted ? result.reason : undefined,
      compactContext: result.compacted ? {
        messages: result.messages,
        boundaryMessageId: lastMsgId,
        snapshot: sessionSnapshot ?? null
      } : undefined,
      messages: result.compacted ? result.messages : undefined,
      boundaryMessageId: result.compacted ? lastMsgId : undefined
    });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof UnsafeConfigError) {
      return badRequest(error);
    }
    return serverError(error instanceof Error ? error : new Error(String(error)));
  }
}
