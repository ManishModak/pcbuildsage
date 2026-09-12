import { getLogsDb, DEFAULT_LOGS_DB_PATH } from "../../../lib/db";
import { json, serverError } from "../_lib/responses";
import { guardHostedRoute } from "@/lib/middleware/route-guard";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const blocked = guardHostedRoute(request);
  if (blocked) return blocked;

  try {
    const url = new URL(request.url);
    let limit = parseInt(url.searchParams.get("limit") || "100", 10);
    if (isNaN(limit)) {
      limit = 100;
    }
    limit = Math.max(1, Math.min(500, limit));

    const db = getLogsDb(DEFAULT_LOGS_DB_PATH);

    const logs = db.prepare(
      "SELECT id, timestamp, level, component, message, details FROM logs ORDER BY id DESC LIMIT ?"
    ).all(limit);

    return json({ logs });
  } catch (error) {
    return serverError(error);
  }
}
