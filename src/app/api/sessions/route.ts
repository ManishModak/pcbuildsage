import { z } from "zod";
import { listSessions, saveSession } from "../../../lib/sessions";
import { badRequest, json, readJson, serverError } from "../_lib/responses";

export const runtime = "nodejs";

const saveSchema = z.object({
  id: z.string(),
  messages: z.array(z.unknown()),
  title: z.string().optional(),
  countryCode: z.string().optional(),
  currency: z.string().optional()
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
    saveSession(body);
    return json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof Error && error.message.includes("Request body")) return badRequest(error);
    return serverError(error);
  }
}
