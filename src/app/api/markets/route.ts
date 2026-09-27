import { getCatalogRepository } from "@/lib/catalog";
import { STANDARD_MARKETS, type MarketMetadata } from "@/lib/config/deployment";
import { json, serverError } from "../_lib/responses";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    let markets: MarketMetadata[];
    try {
      const repo = getCatalogRepository();
      markets = repo.getMarkets ? await repo.getMarkets() : [];
    } catch {
      // If repository connection is unavailable (e.g. unconfigured remote Turso in hosted-demo mode),
      // safely fall back to the available catalog market (India).
      markets = STANDARD_MARKETS.filter((m) => m.code === "IN");
    }

    return json({ markets });
  } catch (error) {
    return serverError(error);
  }
}

