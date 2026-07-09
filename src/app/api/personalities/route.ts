import { loadPersonalities } from "../../../lib/personalities";
import { json } from "../_lib/responses";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return json({ personalities: loadPersonalities() });
}
