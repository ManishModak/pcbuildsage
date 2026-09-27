import { z } from "zod";
import { isHostedDemo } from "@/lib/config/deployment";
import { createSearchClient, checkCrawlerReadiness } from "@/lib/web-search";
import { badRequest, json, serverError } from "../../_lib/responses";
import type { SearchProvider } from "@/types";

export const runtime = "nodejs";

const probeSchema = z.object({
  provider: z.enum(["none", "duckduckgo", "searxng", "brave", "tavily", "exa", "gemini-native"]).optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  checkCrawler: z.boolean().optional(),
  recheck: z.boolean().optional()
});

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json().catch(() => ({}));
    const parsed = probeSchema.parse(body);

    if (parsed.checkCrawler) {
      if (isHostedDemo()) {
        return json({
          ok: false,
          crawler: { ready: false, reason: "Crawler is unavailable in hosted mode" },
          message: "Unavailable: Crawler is unavailable in hosted mode"
        });
      }
      const readiness = await checkCrawlerReadiness({ force: parsed.recheck });
      return json({
        ok: readiness.ready,
        crawler: readiness,
        message: readiness.ready ? "Ready" : `Unavailable: ${readiness.reason ?? "Chromium is missing"}`
      });
    }

    const provider = parsed.provider ?? "none";

    if (provider === "none") {
      return json({ ok: true, resultCount: 0, message: "Search is disabled." });
    }

    if (isHostedDemo()) {
      if (!["brave", "tavily", "exa"].includes(provider)) {
        return badRequest(new Error(`Provider '${provider}' is not supported in hosted mode.`));
      }
    }

    // Resolve API key strictly prioritizing request headers
    const normalizedProvider = provider.toLowerCase();
    const envApiKey = isHostedDemo() ? undefined : process.env[`${provider.toUpperCase()}_API_KEY`];
    const apiKey =
      request.headers.get(`x-pcbuildsage-api-key-${normalizedProvider}`) ||
      request.headers.get(`x-${normalizedProvider}-api-key`) ||
      parsed.apiKey ||
      envApiKey;

    if (["brave", "tavily", "exa"].includes(provider) && !apiKey) {
      return json({ ok: false, error: `${provider} search API key is required.` });
    }

    const client = createSearchClient({
      provider: provider as SearchProvider,
      apiKey: apiKey || undefined,
      baseUrl: isHostedDemo() ? undefined : parsed.baseUrl
    });

    try {
      const response = await client.search("PC hardware", { limit: 1 });
      if (response.error) {
        return json({ ok: false, error: response.error });
      }
      return json({
        ok: true,
        resultCount: response.results.length,
        provider: response.provider,
        message: "Ready"
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ ok: false, error: msg });
    }
  } catch (error) {
    if (error instanceof z.ZodError) return badRequest(error);
    return serverError(error);
  }
}
