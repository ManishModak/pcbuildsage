import { deleteSession, getSession } from "../../../../lib/sessions";
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
