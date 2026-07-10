import { getDb } from "../../../lib/db";
import { json, serverError } from "../_lib/responses";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get("limit") || "100", 10);
    const db = getDb();

    // Safely check if logs table exists
    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='logs'"
    ).get();

    if (!tableExists) {
      return json({ logs: [] });
    }

    const logs = db.prepare(
      "SELECT * FROM logs ORDER BY id DESC LIMIT ?"
    ).all(limit);

    return json({ logs });
  } catch (error) {
    return serverError(error);
  }
}
