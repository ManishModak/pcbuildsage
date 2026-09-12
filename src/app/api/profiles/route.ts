import { listProfiles } from "../_lib/data-files";
import { json } from "../_lib/responses";
import { guardHostedRoute } from "@/lib/middleware/route-guard";

export const runtime = "nodejs";

export async function GET(request?: Request): Promise<Response> {
  const blocked = guardHostedRoute(request);
  if (blocked) return blocked;

  return json({ profiles: listProfiles() });
}

