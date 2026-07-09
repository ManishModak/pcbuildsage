import { listProfiles } from "../_lib/data-files";
import { json } from "../_lib/responses";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return json({ profiles: listProfiles() });
}

