import { loadPersonas } from "../../../lib/personas";
import { json } from "../_lib/responses";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return json({ personas: loadPersonas() });
}
