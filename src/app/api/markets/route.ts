import { listMarkets } from "@/lib/config/markets";
import { json, serverError } from "../_lib/responses";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const markets = listMarkets();
    return json({ markets });
  } catch (error) {
    return serverError(error);
  }
}
