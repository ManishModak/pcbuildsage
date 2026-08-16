import { CorruptSessionError, deleteSession, getSession } from "../../../../lib/sessions";
import { json, serverError } from "../../_lib/responses";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
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

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    deleteSession(id);
    return json({ ok: true });
  } catch (error) {
    return serverError(error);
  }
}
