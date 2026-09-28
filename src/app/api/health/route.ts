import { getDeploymentMode } from "@/lib/config/deployment";
import { json } from "../_lib/responses";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const mode = getDeploymentMode();
  const timestamp = new Date().toISOString();

  // In hosted mode, perform a cheap catalog reachability check (single
  // COUNT query via the configured repository). Never throws: an
  // unreachable catalog still returns HTTP 200 with reachable:false so the
  // Render health check stays green while surfacing catalog state.
  if (mode === "hosted-demo") {
    try {
      const { getCatalogRepository } = await import("@/lib/catalog");
      const repo = getCatalogRepository("hosted-demo");
      const freshness = await repo.getFreshness();
      return json({
        status: "ok",
        mode,
        timestamp,
        catalog: {
          reachable: true,
          productCount: freshness.productCount ?? 0
        }
      });
    } catch {
      return json({
        status: "ok",
        mode,
        timestamp,
        catalog: { reachable: false, productCount: 0 }
      });
    }
  }

  return json({
    status: "ok",
    mode,
    timestamp
  });
}
