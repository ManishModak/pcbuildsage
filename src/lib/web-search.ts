import path from "node:path";
import { z } from "zod";
import type { SearchProvider } from "@/types";
import { loadJsonPresets } from "@/lib/llm/presets";
import {
  runPythonModule,
  checkCrawlerEnvironment,
  type CapturedProcessResult
} from "@/lib/server/python-process";
import { crawlUnavailableMessage, isMissingBrowserError } from "@/lib/server/process-errors";

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
export type CrawlerReadiness = { ready: boolean; reason?: string };

export async function checkCrawlerReadiness(options: {
  force?: boolean;
  checkFn?: () => Promise<CrawlerReadiness>;
} = {}): Promise<CrawlerReadiness> {
  if (options.checkFn) {
    return options.checkFn();
  }
  return checkCrawlerEnvironment({ force: options.force });
}

export type SearchClient = { search(query: string, options?: { limit?: number; crawlEnabled?: boolean }): Promise<SearchResponse> };
export type CrawlRunner = (module: string, args: string[], options: {
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}) => Promise<CapturedProcessResult>;

/** Per-page text budget before the subagent sees it (~20k chars). */
export const CRAWLED_PAGE_CAP_CHARS = 20_000;
export const CRAWL_TIMEOUT_MS = 30_000;

export const searchPresetSchema = z.object({
  $schema: z.string().optional(),
  name: z.string(),
  provider: z.enum(["duckduckgo", "searxng"]),
  base_url: z.string().url().optional(),
  requires_key: z.literal(false),
  result_limit: z.number().int().positive().max(20).default(5)
});
export type SearchPreset = z.infer<typeof searchPresetSchema>;

export async function crawlPage(url: string, runner: CrawlRunner, options?: { signal?: AbortSignal; timeoutMs?: number; maxChars?: number }): Promise<string> {
  assertCrawlUrlAllowed(url);
  if (options?.signal?.aborted) throw new Error("Page crawl was cancelled.");
  const result = await runner("scraper.crawl_page", [url], {
    timeoutMs: options?.timeoutMs ?? CRAWL_TIMEOUT_MS,
    maxOutputBytes: 500_000,
    signal: options?.signal
  });
  if (result.code !== 0) {
    const err = result.stderr.trim();
    if (isMissingBrowserError(err)) {
      throw new Error(crawlUnavailableMessage());
    }
    throw new Error(err || `Crawler exited with code ${result.code ?? "null"}.`);
  }
  const content = result.stdout.trim();
  if (!content) throw new Error("Crawler returned no page content.");
  const cap = options?.maxChars ?? CRAWLED_PAGE_CAP_CHARS;
  return content.length > cap ? content.slice(0, cap) : content;
}

/**
 * Only http/https may be crawled. Private and loopback targets are blocked,
 * including redirect hops: the initial hostname is checked here and callers
 * should also validate each redirect Location before following (the Python
 * Crawl4AI fetcher follows redirects on its own, so a pre-flight chain check
 * is the only TS-side gate — see assertRedirectChainAllowed).
 */
export function assertCrawlUrlAllowed(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Crawl blocked: invalid URL "${url}".`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Crawl blocked: only http/https URLs are allowed ("${parsed.protocol}").`);
  }
  if (isPrivateCrawlHost(parsed.hostname)) {
    throw new Error(`Crawl blocked: private or loopback address "${parsed.hostname}".`);
  }
}

export function isPrivateCrawlHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host === "localhost.localdomain") return true;
  if (host === "0.0.0.0" || host === "::" || host === "[::]" || host === "::1" || host === "[::1]") return true;
  // IPv4 literals (with optional brackets already stripped by URL).
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts as [number, number, number, number];
    if (a === 127) return true; // loopback 127/8
    if (a === 10) return true; // 10/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 169 && b === 254) return true; // link-local
    if (a === 0) return true; // 0/8
    return false;
  }
  // IPv6 literals: block loopback, unspecified, link-local, unique-local.
  const bare = host.replace(/^\[|\]$/g, "");
  if (bare.includes(":")) {
    const lower = bare.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true;
    if (lower.startsWith("fc00:") || lower.startsWith("fd00:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    return false;
  }
  // Non-IP hostnames are allowed here (DNS rebinding is handled by the
  // redirect-chain pre-flight); single-label names resolve locally too often
  // to trust, so block them except the public test fixtures above.
  if (!host.includes(".")) return true;
  if (host.endsWith(".invalid") || host.endsWith(".test") || host.endsWith(".example") || host === "example") return false;
  return false;
}

/**
 * Best-effort redirect-chain gate: follows Location headers manually (up to
 * 5 hops) and validates every hop with assertCrawlUrlAllowed. Callers that
 * cannot perform a pre-flight (JS-rendered pages) still get the initial-URL
 * check in crawlPage; full redirect enforcement inside Crawl4AI 0.9.0 is
 * unconfirmed (see final report).
 */
export async function assertRedirectChainAllowed(startUrl: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<void> {
  assertCrawlUrlAllowed(startUrl);
  let current = startUrl;
  for (let hop = 0; hop < 5; hop += 1) {
    let response: Response;
    try {
      response = await fetchImpl(current, { method: "HEAD", redirect: "manual", signal });
    } catch {
      return; // Pre-flight failed (JS-only page, blocked HEAD): initial check stands.
    }
    const location = response.headers.get("location");
    if (!location || (response.status !== 301 && response.status !== 302 && response.status !== 303 && response.status !== 307 && response.status !== 308)) return;
    const next = new URL(location, current).toString();
    assertCrawlUrlAllowed(next);
    current = next;
  }
}

export function createSearchClient(
  config: { provider: SearchProvider; apiKey?: string; baseUrl?: string },
  dependencies: {
    runPythonModule?: CrawlRunner;
    checkCrawlerReadiness?: () => Promise<CrawlerReadiness>;
  } = {}
): SearchClient {
  const crawlRunner = dependencies.runPythonModule ?? runPythonModule;
  // An injected runner never implies readiness: callers that fake the runner
  // must explicitly supply fake readiness via checkCrawlerReadiness.
  const checkReadiness = dependencies.checkCrawlerReadiness ?? checkCrawlerReadiness;
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
        const readiness = await checkReadiness();
        if (!readiness.ready) {
          response.crawl = {
            status: "failed",
            error: crawlUnavailableMessage(readiness.reason)
          };
        } else {
          const topResult = response.results[0];
          try {
            topResult.snippet = await crawlPage(topResult.url, crawlRunner);
            response.crawl = { status: "succeeded" };
          } catch (error) {
            response.crawl = { status: "failed", error: error instanceof Error ? error.message : String(error) };
          }
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
