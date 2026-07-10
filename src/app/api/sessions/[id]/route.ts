import { deleteSession, getSession } from "../../../../lib/sessions";
import { json, serverError } from "../../_lib/responses";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    return json({ session: getSession(id) });
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
