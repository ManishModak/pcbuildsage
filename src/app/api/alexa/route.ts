/**
 * src/app/api/alexa/route.ts
 *
 * Track B (voice-agent backend): POST /api/alexa takes exactly what
 * POST /api/chat takes and returns the same AI SDK UI message stream, so the
 * page uses useChat unchanged. The only differences from /api/chat:
 * tools come from an MCP client connected to /api/mcp (one MCP session per
 * chat sessionId, CONTRACT section 5) instead of createToolRegistry, and the
 * system prompt carries the voice addendum (CONTRACT section 8).
 *
 * Error envelope (sanitizeErrorMessage, 413 handling) mirrors /api/chat.
 * The sanitizer is duplicated here on purpose: the chat route does not export
 * it, and shared-route edits belong to neither voice track.
 */
import type { UIMessage } from "ai";
import { z } from "zod";
import { continuationMessageId, streamChat, type StreamChatOverrides } from "@/lib/llm/chat-engine";
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
import { classifyErrorType, providerDimension } from "@/lib/analytics/events";
import { flushInBackground, record as recordAnalytics } from "@/lib/analytics/store";
import {
  ALEXA_VOICE_ADDENDUM,
  AlexaMcpSessions,
  getAlexaSessions,
  McpUnavailableError,
  pickForwardHeaders,
  resolveMcpUrl
} from "@/lib/alexa/mcp-tools";

export const runtime = "nodejs";

const messageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().optional(),
  parts: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional()
});

const alexaRequestSchema = z.object({
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
  const plain = mapProviderErrorToPlainLanguage({ message: redacted });
  return plain && !redacted.startsWith(plain) ? `${plain} ${redacted}` : redacted;
}

export async function POST(request: Request): Promise<Response> {
  // Process-wide map: one MCP session per chat sessionId (CONTRACT section 5).
  const sessions: AlexaMcpSessions = getAlexaSessions();
  try {
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
    const body = alexaRequestSchema.parse(rawBody);
    const config = buildAppConfig(request.headers, body.config ?? {});
    const rawCompact =
      body.compactContext ??
      (body.config && typeof body.config === "object" ? (body.config as Record<string, unknown>).compactContext : undefined);
    const clientCompactContext = parseCompactContext(rawCompact);

    let overrides: StreamChatOverrides;
    try {
      const tools = await sessions.getTools({
        chatSessionId: body.sessionId,
        mcpUrl: resolveMcpUrl(request.url),
        headers: pickForwardHeaders(request.headers)
      });
      overrides = { tools, systemPromptSuffix: ALEXA_VOICE_ADDENDUM };
    } catch (error) {
      // MCP unreachable (server down, hosted-demo 403, ...): run the turn
      // with no tools and answer in text. Never a fake card.
      const safeMsg = sanitizeErrorMessage(error instanceof McpUnavailableError ? error : new McpUnavailableError(String(error)), request.headers);
      console.error("POST /api/alexa: MCP unavailable, text-only turn:", safeMsg);
      overrides = { tools: {}, systemPromptSuffix: ALEXA_VOICE_ADDENDUM };
    }

    const result = await streamChat(
      config,
      compactChatMessages(body.messages),
      body.sessionId,
      request.signal,
      clientCompactContext,
      continuationMessageId(body.messages),
      overrides
    );
    try {
      if (body.messages.filter((message) => message.role === "user").length === 1) {
        recordAnalytics("chat_started", "");
      }
      recordAnalytics("provider_used", providerDimension(result.provider));
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
          `POST /api/alexa: Stream Error [model=${result.model ?? "unknown"}, provider=${result.provider ?? "unknown"}, messages=${body.messages.length}, requestSizeChars=${requestSizeChars}]:`,
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
    console.error("POST /api/alexa: Initialization Error:", safeMsg);
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
