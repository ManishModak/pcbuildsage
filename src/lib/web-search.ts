import path from "node:path";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
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

export async function crawlPage(
  url: string,
  runner: CrawlRunner,
  options?: { signal?: AbortSignal; timeoutMs?: number; maxChars?: number; preflight?: CrawlPreflight }
): Promise<string> {
  assertCrawlUrlAllowed(url);
  if (options?.signal?.aborted) throw new Error("Page crawl was cancelled.");
  // Resolve DNS and walk the redirect chain before handing the URL to the
  // Python crawler (which follows redirects on its own). Fails closed.
  await (options?.preflight ?? preflightCrawlUrl)(url, options?.signal);
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

export const DENIED_CRAWL_DOMAINS = [
  "tomshardware.com",
  "techradar.com",
  "pcgamer.com",
  "anandtech.com",
  "futureplc.com",
  "techpowerup.com",
  "3dcenter.org"
] as const;

export function isDeniedCrawlDomain(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  return DENIED_CRAWL_DOMAINS.some(
    (denied) => host === denied || host.endsWith(`.${denied}`)
  );
}

export function filterAllowedSearchResults(results: SearchResult[]): SearchResult[] {
  return results.filter((item) => {
    if (!item?.url) return true;
    try {
      const parsed = new URL(item.url);
      return !isDeniedCrawlDomain(parsed.hostname);
    } catch {
      return true;
    }
  });
}

/**
 * Synchronous URL gate: only http/https, no forbidden domains from anti-scraping
 * terms/policies, and no hostname that is obviously private (localhost, private/
 * loopback/link-local IP literals, single-label names).
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
  if (isDeniedCrawlDomain(parsed.hostname)) {
    throw new Error(`Crawl blocked: domain "${parsed.hostname}" is forbidden by terms or anti-scraping policy.`);
  }
  if (isPrivateCrawlHost(parsed.hostname)) {
    throw new Error(`Crawl blocked: private or loopback address "${parsed.hostname}".`);
  }
}

/** True for hostnames that must never be crawled (IP literals checked by range). */
export function isPrivateCrawlHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host === "localhost.localdomain") return true;
  if (isIP(host)) return isPrivateAddress(host);
  // Bare numeric forms like "2130706433" or "0x7f.1" are IPv4 to some
  // resolvers; never crawl them.
  if (/^[0-9.x]+$/i.test(host) && /^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/i.test(host)) return true;
  // Single-label names resolve locally too often to trust.
  return !host.includes(".");
}

/**
 * True for IP addresses that are not public unicast: loopback, private,
 * link-local, CGNAT (100.64/10), unspecified, multicast/reserved, and
 * IPv6 unique-local, link-local and IPv4-mapped/NAT64 forms of those.
 */
export function isPrivateAddress(address: string): boolean {
  const addr = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(addr);
  if (family === 4) return isPrivateIPv4(addr.split(".").map(Number));
  if (family !== 6) return true;
  const words = expandIPv6(addr);
  if (!words) return true;
  if (words.every((w) => w === 0)) return true; // ::
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64
  // (64:ff9b::a.b.c.d): judge the embedded IPv4 address.
  const embedded = [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff];
  if (words.slice(0, 5).every((w) => w === 0) && (words[5] === 0xffff || words[5] === 0)) return isPrivateIPv4(embedded);
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0)) return isPrivateIPv4(embedded);
  const first = words[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true; // multicast
  return false;
}

function isPrivateIPv4(parts: number[]): boolean {
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-network, 10/8, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0/24 IETF
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Expands an IPv6 string (optionally with a trailing dotted IPv4) to 8 words. */
function expandIPv6(addr: string): number[] | undefined {
  let text = addr.split("%")[0];
  const v4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const p = v4[1].split(".").map(Number);
    text = text.slice(0, -v4[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const parse = (part: string | undefined) => (part ? part.split(":").map((w) => Number.parseInt(w, 16)) : []);
  const left = parse(head);
  const right = parse(tail);
  const words = tail === undefined ? left : [...left, ...new Array(8 - left.length - right.length).fill(0), ...right];
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : undefined;
}

/** Pre-flight gate run before every crawl; rejects to block the crawl. */
export type CrawlPreflight = (url: string, signal?: AbortSignal) => Promise<void>;
export type CrawlLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

/** Budget for the whole pre-flight (DNS + redirect hops). */
export const CRAWL_PREFLIGHT_TIMEOUT_MS = 10_000;
export const CRAWL_MAX_REDIRECTS = 5;

const defaultLookup: CrawlLookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Throws unless every address the hostname resolves to is public. IP
 * literals are checked directly; DNS failures and empty answers block.
 */
export async function assertHostResolvesPublic(hostname: string, lookup: CrawlLookup = defaultLookup): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`Crawl blocked: private or loopback address "${hostname}".`);
    return;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host);
  } catch (error) {
    throw new Error(`Crawl blocked: could not resolve "${hostname}" (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (addresses.length === 0) throw new Error(`Crawl blocked: "${hostname}" did not resolve.`);
  const bad = addresses.find((entry) => isPrivateAddress(entry.address));
  if (bad) throw new Error(`Crawl blocked: "${hostname}" resolves to private or loopback address ${bad.address}.`);
}

/**
 * Crawl pre-flight: follows the redirect chain manually (at most
 * CRAWL_MAX_REDIRECTS hops), checking every hop's URL and resolved
 * addresses. Fails CLOSED: a DNS error, network error, timeout or too many
 * redirects blocks the crawl. Returns the final (non-redirect) URL.
 *
 * Residual risk: Crawl4AI re-resolves DNS itself, so a rebinding host could
 * still answer differently to the crawler than to this check.
 */
export async function preflightCrawlUrl(
  startUrl: string,
  signal?: AbortSignal,
  deps: { fetchImpl?: typeof fetch; lookup?: CrawlLookup; timeoutMs?: number } = {}
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const lookup = deps.lookup ?? defaultLookup;
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? CRAWL_PREFLIGHT_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let current = startUrl;
  for (let hop = 0; ; hop += 1) {
    assertCrawlUrlAllowed(current);
    await assertHostResolvesPublic(new URL(current).hostname, lookup);
    let response: Response;
    try {
      response = await fetchImpl(current, { method: "GET", redirect: "manual", signal: requestSignal });
    } catch (error) {
      if (signal?.aborted) throw new Error("Page crawl was cancelled.");
      throw new Error(`Crawl blocked: pre-flight request to ${current} failed (${error instanceof Error ? error.message : String(error)}).`);
    }
    // Only the status and Location matter; drop the body.
    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) {
      try {
        const robotsUrl = new URL("/robots.txt", current).toString();
        const robotsRes = await fetchImpl(robotsUrl, { method: "GET", signal: requestSignal });
        if (robotsRes.ok) {
          const robotsTxt = await robotsRes.text();
          const path = new URL(current).pathname;
          if (isPathDisallowedByRobotsTxt(robotsTxt, path)) {
            throw new Error(`Crawl blocked: URL "${current}" is disallowed by site robots.txt.`);
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes("Crawl blocked")) throw err;
      }
      return current;
    }
    if (hop >= CRAWL_MAX_REDIRECTS) throw new Error(`Crawl blocked: more than ${CRAWL_MAX_REDIRECTS} redirects from ${startUrl}.`);
    current = new URL(location, current).toString();
  }
}

export function isPathDisallowedByRobotsTxt(robotsTxt: string, pathname: string): boolean {
  const lines = robotsTxt.split(/\r?\n/);
  let userAgentApplies = false;
  for (const rawLine of lines) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (key === "user-agent") {
      userAgentApplies = value === "*";
    } else if (userAgentApplies && key === "disallow") {
      if (value === "/" || (value !== "" && pathname.startsWith(value))) {
        return true;
      }
    }
  }
  return false;
}

export function createSearchClient(
  config: { provider: SearchProvider; apiKey?: string; baseUrl?: string },
  dependencies: {
    runPythonModule?: CrawlRunner;
    checkCrawlerReadiness?: () => Promise<CrawlerReadiness>;
    /** Crawl SSRF pre-flight; defaults to preflightCrawlUrl (DNS + redirects). */
    crawlPreflight?: CrawlPreflight;
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

      response.results = filterAllowedSearchResults(response.results);

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
            topResult.snippet = await crawlPage(topResult.url, crawlRunner, { preflight: dependencies.crawlPreflight });
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

async function searxng(query: string, baseUrl = process.env.SEARXNG_BASE_URL ?? "http://localhost:8888", limit = 5): Promise<SearchResponse> {
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
