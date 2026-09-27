import { getCatalogRepository } from "@/lib/catalog";
import type { MarketMetadata } from "@/lib/config/deployment";
import { json, serverError } from "../_lib/responses";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    let markets: MarketMetadata[] = [];
    try {
      const repo = getCatalogRepository();
      markets = repo.getMarkets ? await repo.getMarkets() : [];
    } catch {
      markets = [];
    }

    return json({ markets });
  } catch (error) {
    return serverError(error);
  }
}

