import { z } from "zod";
import { listSessions, saveSession } from "../../../lib/sessions";
import { deriveBuildState } from "@/lib/llm/messages";
import { badRequest, InvalidJsonError, json, readJson, serverError } from "../_lib/responses";
import { guardHostedRoute } from "@/lib/middleware/route-guard";
import type { UIMessage } from "ai";

export const runtime = "nodejs";

const HOSTED_MODE_FORBIDDEN_RESPONSE = {
  error: "forbidden",
  message: "Server-side sessions are disabled in hosted demo mode. Chat history is stored locally in your browser."
};

const messageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system", "tool", "data"]),
  content: z.string().optional(),
  parts: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
      input: z.unknown().optional(),
      output: z.unknown().optional()
    }).passthrough()
  ).optional(),
  annotations: z.array(z.unknown()).optional()
}).passthrough();

const saveSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().nonnegative(),
  messages: z.array(messageSchema),
  title: z.string().optional().nullable(),
  countryCode: z.string().optional().nullable(),
  currency: z.string().optional().nullable()
});

export async function GET(request: Request = new Request("http://localhost/api/sessions")): Promise<Response> {
  const blocked = guardHostedRoute(request, { customPayload: HOSTED_MODE_FORBIDDEN_RESPONSE });
  if (blocked) return blocked;

  try {
    return json({ sessions: listSessions() });
  } catch (error) {
    return serverError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const blocked = guardHostedRoute(request, { customPayload: HOSTED_MODE_FORBIDDEN_RESPONSE });
  if (blocked) return blocked;
  try {
    const body = saveSchema.parse(await readJson(request));
    const buildState = deriveBuildState(body.messages as UIMessage[]);
    const result = saveSession({
      ...body,
      buildState: buildState
    });
    if (result.status === "deleted") {
      return json({ error: "session_deleted", message: "Deleted session cannot be recreated." }, { status: 409 });
    }
    if (result.status === "stale") {
      return json(
        { error: "stale_revision", message: "A newer session revision already exists.", revision: result.revision },
        { status: 409 }
      );
    }
    return json({ ok: true, revision: result.revision });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof InvalidJsonError) return badRequest(error);
    return serverError(error);
  }
}
