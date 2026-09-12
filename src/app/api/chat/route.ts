import type { UIMessage } from "ai";
import { z } from "zod";
import { streamChat } from "@/lib/llm/chat-engine";
import { compactChatMessages } from "@/lib/llm/messages";
import { buildAppConfig, UnsafeConfigError } from "../_lib/credentials";
import { badRequest, readJson, serverError } from "../_lib/responses";

export const runtime = "nodejs";

const messageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().optional(),
  parts: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional()
});

const chatRequestSchema = z.object({
  messages: z.array(messageSchema),
  sessionId: z.string().optional(),
  config: z.unknown().optional()
});

function sanitizeErrorMessage(error: unknown, headers?: Headers): string {
  let msg = error instanceof Error ? error.message : String(error);
  if (headers) {
    for (const [name, val] of headers.entries()) {
      if (/api[-_]?key/i.test(name) && val.length >= 4) {
        msg = msg.replaceAll(val, "[REDACTED]");
      }
    }
  }
  return msg
    .replace(/\bAIza[0-9A-Za-z-_]{20,}\b/g, "[REDACTED]")
    .replace(/\bsk-(?:or-v1-)?[0-9A-Za-z-_]{15,}\b/g, "[REDACTED]")
    .replace(/([?&](?:api[_-]?key|key)=)[^&\s]+/gi, "$1[REDACTED]");
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = chatRequestSchema.parse(await readJson(request));
    const config = buildAppConfig(request.headers, body.config ?? {});
    
    const result = await streamChat(config, compactChatMessages(body.messages), body.sessionId, request.signal);
    return result.toUIMessageStreamResponse<UIMessage<{ provider: string; model: string; fallbackIndex: number; primaryError?: string }>>({
      messageMetadata: () => ({
        provider: result.provider,
        model: result.model,
        fallbackIndex: result.fallbackIndex,
        primaryError: result.errors?.[0]
          ? sanitizeErrorMessage(result.errors[0], request.headers)
          : undefined
      }),
      onError: (error: unknown) => {
        const safeMsg = sanitizeErrorMessage(error, request.headers);
        console.error("POST /api/chat: Stream Error:", safeMsg);
        return safeMsg;
      }
    });
  } catch (error) {
    const safeMsg = sanitizeErrorMessage(error, request.headers);
    console.error("POST /api/chat: Initialization Error:", safeMsg);
    if (
      error instanceof z.ZodError ||
      error instanceof UnsafeConfigError ||
      (error instanceof Error && (error.message.includes("Request body") || error.name === "UnsafeConfigError"))
    ) {
      if (error instanceof UnsafeConfigError) {
        return badRequest(new UnsafeConfigError(safeMsg));
      }
      return badRequest(error);
    }
    return serverError(error instanceof Error ? new Error(safeMsg) : error);
  }
}


