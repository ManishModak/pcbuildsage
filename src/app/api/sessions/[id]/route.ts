import { CorruptSessionError, deleteSession, getSession } from "../../../../lib/sessions";
import { json, serverError } from "../../_lib/responses";
import { guardHostedRoute } from "@/lib/middleware/route-guard";

export const runtime = "nodejs";

const HOSTED_MODE_FORBIDDEN_RESPONSE = {
  error: "forbidden",
  message: "Server-side sessions are disabled in hosted demo mode. Chat history is stored locally in your browser."
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const blocked = guardHostedRoute(request, { customPayload: HOSTED_MODE_FORBIDDEN_RESPONSE });
  if (blocked) return blocked;

  try {
    const { id } = await context.params;
    const session = getSession(id);
    if (!session) {
      return json({ error: "not_found", message: "Session not found" }, { status: 404 });
    }
    return json({ session });
  } catch (error) {
    if (error instanceof CorruptSessionError) {
      return json({ error: "corrupt_session", message: error.message }, { status: 422 });
    }
    return serverError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const blocked = guardHostedRoute(request, { customPayload: HOSTED_MODE_FORBIDDEN_RESPONSE });
  if (blocked) return blocked;
  try {
    const { id } = await context.params;
    deleteSession(id);
    return json({ ok: true });
  } catch (error) {
    return serverError(error);
  }
}
