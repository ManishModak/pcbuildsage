import { z } from "zod";
import { listSessions, saveSession } from "../../../lib/sessions";
import { deriveBuildState } from "@/lib/llm/messages";
import { badRequest, json, readJson, serverError } from "../_lib/responses";
import type { UIMessage } from "ai";

export const runtime = "nodejs";

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
  id: z.string(),
  messages: z.array(messageSchema),
  title: z.string().optional().nullable(),
  countryCode: z.string().optional().nullable(),
  currency: z.string().optional().nullable()
});

export async function GET(): Promise<Response> {
  try {
    return json({ sessions: listSessions() });
  } catch (error) {
    return serverError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = saveSchema.parse(await readJson(request));
    const buildState = deriveBuildState(body.messages as UIMessage[]);
    saveSession({
      ...body,
      buildState: buildState
    });
    return json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof Error && error.message.includes("Request body")) return badRequest(error);
    return serverError(error);
  }
}

