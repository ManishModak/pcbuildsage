import { getDeploymentMode } from "@/lib/config/deployment";
import { json } from "../_lib/responses";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return json({
    status: "ok",
    mode: getDeploymentMode(),
    timestamp: new Date().toISOString()
  });
}
