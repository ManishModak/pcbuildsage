import path from "node:path";
import { z } from "zod";
import type { SearchProvider } from "@/types";
import { loadJsonPresets } from "@/lib/llm/presets";
import { runPythonModule, type CapturedProcessResult } from "@/lib/server/python-process";

export type SearchResult = { title: string; url: string; snippet: string };
export type CrawlDiagnostic =
  | { status: "succeeded" }
  | { status: "failed"; error: string }
  | { status: "skipped"; reason: "no_results" };
export type SearchResponse = {
  results: SearchResult[];
  provider: SearchProvider;
  grounded: boolean;
  crawl?: CrawlDiagnostic;
  error?: string;
};
export type SearchClient = { search(query: string, options?: { limit?: number; crawlEnabled?: boolean }): Promise<SearchResponse> };
export type CrawlRunner = (module: string, args: string[], options: {
  timeoutMs: number;
  maxOutputBytes: number;
}) => Promise<CapturedProcessResult>;

export const searchPresetSchema = z.object({
  $schema: z.string().optional(),
  name: z.string(),
  provider: z.enum(["duckduckgo", "searxng"]),
  base_url: z.string().url().optional(),
  requires_key: z.literal(false),
  result_limit: z.number().int().positive().max(20).default(5)
});
export type SearchPreset = z.infer<typeof searchPresetSchema>;

export async function crawlPage(url: string, runner: CrawlRunner): Promise<string> {
  const result = await runner("scraper.crawl_page", [url], {
    timeoutMs: 30_000,
    maxOutputBytes: 500_000
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `Crawler exited with code ${result.code ?? "null"}.`);
  }
  const content = result.stdout.trim();
  if (!content) throw new Error("Crawler returned no page content.");
  return content;
}

export function createSearchClient(
  config: { provider: SearchProvider; apiKey?: string; baseUrl?: string },
  dependencies: { runPythonModule?: CrawlRunner } = {}
): SearchClient {
  const crawlRunner = dependencies.runPythonModule ?? runPythonModule;
  return {
    async search(query, options = {}) {
      if (config.provider === "none" || config.provider === "gemini-native") {
        return { results: [], provider: config.provider, grounded: config.provider === "gemini-native" };
      }
      if (!config.apiKey && ["exa", "tavily", "brave"].includes(config.provider)) {
        return { results: [], provider: config.provider, grounded: false, error: `${config.provider} search API key is not configured.` };
      }

      let response: SearchResponse;
      if (config.provider === "searxng") {
        response = await searxng(query, config.baseUrl, options.limit);
      } else if (config.provider === "duckduckgo") {
        response = await duckduckgo(query, options.limit);
      } else {
        response = await keyedSearch(query, config.provider, config.apiKey!, options.limit);
      }

      if (options.crawlEnabled && response.results.length > 0) {
        const topResult = response.results[0];
        try {
          topResult.snippet = await crawlPage(topResult.url, crawlRunner);
          response.crawl = { status: "succeeded" };
        } catch (error) {
          response.crawl = { status: "failed", error: error instanceof Error ? error.message : String(error) };
        }
      } else if (options.crawlEnabled) {
        response.crawl = { status: "skipped", reason: "no_results" };
      }

      return response;
    }
  };
}

export function loadSearchPresets(dir = path.join(process.cwd(), "data", "search")): SearchPreset[] {
  return loadJsonPresets(dir, searchPresetSchema, {
    collectionLabel: "search presets",
    invalidLabel: "search preset"
  });
}

async function searxng(query: string, baseUrl = process.env.SEARXNG_BASE_URL ?? "http://localhost:8080", limit = 5): Promise<SearchResponse> {
  const url = new URL("/search", baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  const response = await fetch(url);
  assertSearchOk(response, "searxng");
  const json = (await response.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return { provider: "searxng", grounded: true, results: (json.results ?? []).slice(0, limit).map((item) => ({ title: item.title ?? item.url ?? "", url: item.url ?? "", snippet: item.content ?? "" })) };
}

async function duckduckgo(query: string, limit = 5): Promise<SearchResponse> {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
  });
  assertSearchOk(response, "duckduckgo");
  const html = await response.text();
  const results: SearchResult[] = [];
  const linkRegex = /<a rel="nofollow" class="result__a" href="([^"]+)">(.*?)<\/a>/g;
  const snippetRegex = /<a class="result__snippet[^>]*>([\s\S]*?)<\/a>/g;

  const links = [...html.matchAll(linkRegex)];
  const snippets = [...html.matchAll(snippetRegex)];

  for (let i = 0; i < Math.min(links.length, limit); i++) {
    const rawHref = links[i][1];
    const rawTitle = links[i][2].replace(/<[^>]+>/g, "").trim();
    const snippet = snippets[i] ? snippets[i][1].replace(/<[^>]+>/g, "").trim() : "";
    const uddgMatch = rawHref.match(/uddg=([^&]+)/);
    const resultUrl = uddgMatch ? decodeURIComponent(uddgMatch[1]) : rawHref;
    if (resultUrl) {
      results.push({ title: rawTitle || resultUrl, url: resultUrl, snippet });
    }
  }
  return { provider: "duckduckgo", grounded: results.length > 0, results };
}

async function keyedSearch(query: string, provider: Exclude<SearchProvider, "none" | "duckduckgo" | "searxng" | "gemini-native">, apiKey: string, limit = 5): Promise<SearchResponse> {
  const endpoints: Record<string, string> = {
    brave: "https://api.search.brave.com/res/v1/web/search",
    exa: "https://api.exa.ai/search",
    tavily: "https://api.tavily.com/search"
  };
  const url = new URL(endpoints[provider]);
  if (provider === "brave") url.searchParams.set("q", query);
  const init: RequestInit =
    provider === "brave"
      ? { headers: { "X-Subscription-Token": apiKey } }
      : provider === "exa"
        ? { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": apiKey }, body: JSON.stringify({ query, numResults: limit }) }
        : { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ query, max_results: limit }) };
  const response = await fetch(url, init);
  assertSearchOk(response, provider);
  const json = (await response.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string; snippet?: string; text?: string }> }; results?: Array<{ title?: string; url?: string; description?: string; snippet?: string; text?: string }> };
  const raw = provider === "brave" ? json.web?.results : json.results;
  return { provider, grounded: true, results: (raw ?? []).slice(0, limit).map((item) => ({ title: item.title ?? "", url: item.url ?? "", snippet: item.description ?? item.snippet ?? item.text ?? "" })) };
}

function assertSearchOk(response: Response, provider: string): void {
  if (!response.ok) throw new Error(`${provider} search failed: HTTP ${response.status}`);
}
