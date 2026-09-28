import type { UIMessage } from "ai";
import { z } from "zod";
import { streamChat } from "@/lib/llm/chat-engine";
import { compactChatMessages } from "@/lib/llm/messages";
import { mapProviderErrorToPlainLanguage } from "@/content/api-key-help";
import { parseCompactContext, type StoredCompactContext } from "@/lib/sessions";
import { buildAppConfig, UnsafeConfigError } from "../_lib/credentials";
import { badRequest, readJson, serverError } from "../_lib/responses";
import {
  checkChatPayloadSize,
  exceedsHostedChatBodyLimit,
  HOSTED_CHAT_MAX_BODY_BYTES
} from "@/lib/config/deployment";
import { classifyErrorType, sanitizeProviderDimension } from "@/lib/analytics/events";
import { flushInBackground, record as recordAnalytics } from "@/lib/analytics/store";

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
  config: z.unknown().optional(),
  compactContext: z.unknown().optional()
});

function extractDetailedErrorMessage(error: unknown): string {
  if (!error) return "Unknown error";

  if (error && typeof error === "object" && "errors" in error && Array.isArray((error as { errors: unknown[] }).errors)) {
    const childDetails = (error as { errors: unknown[] }).errors.map((e) => extractDetailedErrorMessage(e));
    return childDetails.filter(Boolean).join("; ") || (error as { message?: string }).message || "Unknown error";
  }

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
  const redacted = msg
    .replace(/\bAIza[0-9A-Za-z-_]{20,}\b/g, "[REDACTED]")
    .replace(/\bsk-(?:or-v1-)?[0-9A-Za-z-_]{15,}\b/g, "[REDACTED]")
    .replace(/([?&](?:api[_-]?key|key)=)[^&\s]+/gi, "$1[REDACTED]");
  // Lead with plain language for rejected keys / exhausted free quotas so the
  // chat UI can show it even before client-side formatting runs. Redaction
  // above runs first so secrets never reach the appended detail.
  const plain = mapProviderErrorToPlainLanguage({ message: redacted });
  return plain && !redacted.startsWith(plain) ? `${plain} ${redacted}` : redacted;
}

export async function POST(request: Request): Promise<Response> {
  try {
    // Payload caps apply only in hosted-demo mode (no-ops locally).
    if (exceedsHostedChatBodyLimit(request.headers)) {
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
    const body = chatRequestSchema.parse(rawBody);
    const config = buildAppConfig(request.headers, body.config ?? {});
    const rawCompact =
      body.compactContext ??
      (body.config && typeof body.config === "object" ? (body.config as Record<string, unknown>).compactContext : undefined);
    const clientCompactContext = parseCompactContext(rawCompact);

    const result = await streamChat(
      config,
      compactChatMessages(body.messages),
      body.sessionId,
      request.signal,
      clientCompactContext
    );
    // Anonymous hosted-only counters; each call is total and fire-and-forget.
    try {
      recordAnalytics("chat_started", "");
      recordAnalytics(
        "provider_used",
        sanitizeProviderDimension(result.provider, result.model)
      );
    } catch {
      // Never break chat for analytics.
    }
    flushInBackground();
    return result.toUIMessageStreamResponse<UIMessage<{ provider: string; model: string; fallbackIndex: number; primaryError?: string; compactContext?: StoredCompactContext }>>({
      generateMessageId: () => result.responseMessageId,
      messageMetadata: () => ({
        provider: result.provider,
        model: result.model,
        fallbackIndex: result.fallbackIndex,
        primaryError: result.errors?.[0]
          ? sanitizeErrorMessage(result.errors[0], request.headers)
          : undefined,
        compactContext: result.compactContext ?? undefined
      }),
      onError: (error: unknown) => {
        const safeMsg = sanitizeErrorMessage(error, request.headers);
        try {
          recordAnalytics("error_type", classifyErrorType(error));
        } catch {
          // Never break chat for analytics.
        }
        flushInBackground();
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
    try {
      recordAnalytics("error_type", classifyErrorType(error));
    } catch {
      // Never break chat for analytics.
    }
    flushInBackground();
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


