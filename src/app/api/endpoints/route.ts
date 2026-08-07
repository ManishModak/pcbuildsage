import { loadEndpointPresets } from "@/lib/llm/endpoints";
import { json } from "../_lib/responses";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return json({ endpoints: loadEndpointPresets() });
}
