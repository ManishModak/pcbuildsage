import type { UIMessage } from "ai";
import { z } from "zod";
import { streamChat, type ChatMessage } from "../../../lib/chat-engine";
import { buildAppConfig } from "../_lib/credentials";
import { badRequest, readJson, serverError } from "../_lib/responses";

export const runtime = "nodejs";

const messageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().optional(),
  parts: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional()
});

const chatRequestSchema = z.object({
  messages: z.array(messageSchema),
  config: z.unknown().optional()
});

export async function POST(request: Request): Promise<Response> {
  try {
    const body = chatRequestSchema.parse(await readJson(request));
    const config = buildAppConfig(request.headers, body.config ?? {});
    const result = await streamChat(config, body.messages.map(toChatMessage));
    return result.toUIMessageStreamResponse<UIMessage<{ provider: string; model: string; fallbackIndex: number }>>({
      messageMetadata: () => ({
        provider: result.provider,
        model: result.model,
        fallbackIndex: result.fallbackIndex
      })
    });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof Error && error.message.includes("Request body")) return badRequest(error);
    return serverError(error);
  }
}

function toChatMessage(message: z.infer<typeof messageSchema>): ChatMessage {
  return {
    role: message.role,
    content: message.content ?? message.parts?.filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n") ?? ""
  };
}
