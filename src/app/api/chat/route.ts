import type { UIMessage } from "ai";
import { z } from "zod";
import { streamChat } from "@/lib/llm/chat-engine";
import { compactChatMessages } from "@/lib/llm/messages";
import { buildAppConfig } from "../_lib/credentials";
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

export async function POST(request: Request): Promise<Response> {
  try {
    const body = chatRequestSchema.parse(await readJson(request));
    const config = buildAppConfig(request.headers, body.config ?? {});
    
    const result = await streamChat(config, compactChatMessages(body.messages), body.sessionId);
    return result.toUIMessageStreamResponse<UIMessage<{ provider: string; model: string; fallbackIndex: number; primaryError?: string }>>({
      messageMetadata: () => ({
        provider: result.provider,
        model: result.model,
        fallbackIndex: result.fallbackIndex,
        primaryError: result.errors?.[0] instanceof Error ? result.errors[0].message : (result.errors?.[0] ? String(result.errors[0]) : undefined)
      }),
      onError: (error: unknown) => {
        console.error("POST /api/chat: Stream Error:", error);
        return error instanceof Error ? error.message : String(error);
      }
    });
  } catch (error) {
    console.error("POST /api/chat: Initialization Error:", error);
    if (error instanceof z.ZodError || error instanceof Error && error.message.includes("Request body")) return badRequest(error);
    return serverError(error);
  }
}

