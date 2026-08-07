import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";
import type { SearchProvider } from "@/types";
import { loadJsonPresets } from "@/lib/llm/presets";

const execFilePromise = promisify(execFile);

export type SearchResult = { title: string; url: string; snippet: string };
export type SearchResponse = { results: SearchResult[]; provider: SearchProvider; grounded: boolean };
export type SearchClient = { search(query: string, options?: { limit?: number; crawlEnabled?: boolean }): Promise<SearchResponse> };

export const searchPresetSchema = z.object({
  $schema: z.string().optional(),
  name: z.string(),
  provider: z.enum(["duckduckgo", "searxng"]),
  base_url: z.string().url().optional(),
  requires_key: z.literal(false),
  result_limit: z.number().int().positive().max(20).default(5)
});
export type SearchPreset = z.infer<typeof searchPresetSchema>;

function getPythonCommand(): string {
  const cwd = process.cwd();
  const venvBinPath = path.join(cwd, ".venv", "bin", "python");
  const venvScriptsPath = path.join(cwd, ".venv", "Scripts", "python.exe");

  if (existsSync(venvBinPath)) {
    return venvBinPath;
  }
  if (existsSync(venvScriptsPath)) {
    return venvScriptsPath;
  }
  return "python3";
}

async function crawlPage(url: string): Promise<string> {
  const pythonCmd = getPythonCommand();
  const scriptPath = path.join(process.cwd(), "src", "scraper", "crawl_page.py");
  try {
    const { stdout } = await execFilePromise(pythonCmd, [scriptPath, url]);
    return stdout.trim();
  } catch (error) {
    console.error("Crawl error:", error);
    return "";
  }
}

export function createSearchClient(config: { provider: SearchProvider; apiKey?: string; baseUrl?: string }): SearchClient {
  return {
    async search(query, options = {}) {
      if (config.provider === "none" || config.provider === "gemini-native") {
        return { results: [], provider: config.provider, grounded: config.provider === "gemini-native" };
      }
      if (!config.apiKey && ["exa", "tavily", "brave"].includes(config.provider)) {
        return { results: [], provider: config.provider, grounded: false };
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
          const crawledContent = await crawlPage(topResult.url);
          if (crawledContent) {
            topResult.snippet = crawledContent;
          }
        } catch (err) {
          console.error(`Crawling failed for ${topResult.url}:`, err);
        }
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
  const json = (await response.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return { provider: "searxng", grounded: true, results: (json.results ?? []).slice(0, limit).map((item) => ({ title: item.title ?? item.url ?? "", url: item.url ?? "", snippet: item.content ?? "" })) };
}

async function duckduckgo(query: string, limit = 5): Promise<SearchResponse> {
  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_redirect", "1");
  const response = await fetch(url);
  const json = (await response.json()) as { RelatedTopics?: Array<{ Text?: string; FirstURL?: string }> };
  return { provider: "duckduckgo", grounded: true, results: (json.RelatedTopics ?? []).slice(0, limit).map((item) => ({ title: item.Text?.split(" - ")[0] ?? "", url: item.FirstURL ?? "", snippet: item.Text ?? "" })) };
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
  const json = (await response.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string; snippet?: string; text?: string }> }; results?: Array<{ title?: string; url?: string; description?: string; snippet?: string; text?: string }> };
  const raw = provider === "brave" ? json.web?.results : json.results;
  return { provider, grounded: true, results: (raw ?? []).slice(0, limit).map((item) => ({ title: item.title ?? "", url: item.url ?? "", snippet: item.description ?? item.snippet ?? item.text ?? "" })) };
}
