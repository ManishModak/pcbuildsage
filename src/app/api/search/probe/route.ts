import { z } from "zod";
import { isHostedDemo } from "@/lib/config/deployment";
import { createSearchClient } from "@/lib/web-search";
import { badRequest, json, serverError } from "../../_lib/responses";
import type { SearchProvider } from "@/types";

export const runtime = "nodejs";

const probeSchema = z.object({
  provider: z.enum(["none", "duckduckgo", "searxng", "brave", "tavily", "exa", "gemini-native"]),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional()
});

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json().catch(() => ({}));
    const parsed = probeSchema.parse(body);
    const { provider } = parsed;

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
    const apiKey =
      request.headers.get(`x-pcbuildsage-api-key-${normalizedProvider}`) ||
      request.headers.get(`x-${normalizedProvider}-api-key`) ||
      parsed.apiKey ||
      process.env[`${provider.toUpperCase()}_API_KEY`];

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
        provider: response.provider
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
