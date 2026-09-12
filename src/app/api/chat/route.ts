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

function extractDetailedErrorMessage(error: unknown): string {
  if (!error) return "Unknown error";

  if (typeof error === "object" && error !== null) {
    const errObj = error as Record<string, unknown>;
    const statusCode = errObj.statusCode ?? (errObj.status as number | undefined);
    const responseBody = errObj.responseBody;

    let bodyDetail = "";
    if (typeof responseBody === "string") {
      try {
        const parsed = JSON.parse(responseBody);
        if (parsed?.error && typeof parsed.error === "object") {
          const err = parsed.error as Record<string, unknown>;
          bodyDetail = String(err.message ?? "");
          if (err.metadata && typeof err.metadata === "object") {
            const meta = err.metadata as Record<string, unknown>;
            if (meta.raw && typeof meta.raw === "string") {
              const rawSample = meta.raw.slice(0, 200);
              bodyDetail = bodyDetail ? `${bodyDetail} (${rawSample})` : rawSample;
            }
          }
        } else if (parsed?.message) {
          bodyDetail = String(parsed.message);
        } else {
          bodyDetail = responseBody.slice(0, 300);
        }
      } catch {
        bodyDetail = responseBody.slice(0, 300);
      }
    } else if (typeof responseBody === "object" && responseBody !== null) {
      const parsed = responseBody as Record<string, unknown>;
      if (parsed.error && typeof parsed.error === "object") {
        const err = parsed.error as Record<string, unknown>;
        bodyDetail = String(err.message ?? "");
        if (err.metadata && typeof err.metadata === "object") {
          const meta = err.metadata as Record<string, unknown>;
          if (meta.raw && typeof meta.raw === "string") {
            const rawSample = meta.raw.slice(0, 200);
            bodyDetail = bodyDetail ? `${bodyDetail} (${rawSample})` : rawSample;
          }
        }
      } else if (parsed.message) {
        bodyDetail = String(parsed.message);
      }
    }

    const baseMessage = error instanceof Error ? error.message : String(errObj.message || "");

    if (bodyDetail && bodyDetail !== baseMessage) {
      return statusCode ? `[HTTP ${statusCode}] ${bodyDetail} (${baseMessage})` : `${bodyDetail} (${baseMessage})`;
    }

    if (statusCode && !baseMessage.includes(String(statusCode))) {
      return `[HTTP ${statusCode}] ${baseMessage}`;
    }

    if (errObj.cause && errObj.cause !== error) {
      const causeMsg = errObj.cause instanceof Error ? errObj.cause.message : String(errObj.cause);
      if (causeMsg && !baseMessage.includes(causeMsg)) {
        return `${baseMessage}: ${causeMsg}`;
      }
    }

    if (baseMessage) return baseMessage;
  }

  return error instanceof Error ? error.message : String(error);
}

function sanitizeErrorMessage(error: unknown, headers?: Headers): string {
  let msg = extractDetailedErrorMessage(error);
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
        const requestSizeChars = JSON.stringify(body.messages).length;
        console.error(
          `POST /api/chat: Stream Error [model=${result.model ?? "unknown"}, provider=${result.provider ?? "unknown"}, messages=${body.messages.length}, requestSizeChars=${requestSizeChars}]:`,
          safeMsg
        );
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


