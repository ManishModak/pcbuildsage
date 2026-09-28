import { isStepCount, tool, type ToolSet } from "ai";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { generateTextWithFallback, getEntryTimeoutMs } from "@/lib/llm/client";
import { appendChatLog } from "@/lib/logger";
import { slugifyComponent } from "@/lib/normalizer";
import {
  createSearchClient,
  crawlPage,
  checkCrawlerReadiness,
  assertCrawlUrlAllowed,
  CRAWLED_PAGE_CAP_CHARS,
  CRAWL_TIMEOUT_MS,
  CRAWL_PREFLIGHT_TIMEOUT_MS,
  type CrawlerReadiness,
  type CrawlRunner,
  type CrawlPreflight,
  type SearchClient,
  type SearchResponse,
  type SearchResult
} from "@/lib/web-search";
import { runPythonModule } from "@/lib/server/python-process";
import { crawlUnavailableMessage } from "@/lib/server/process-errors";
import type { AppConfig, AuditCacheEntry, RegistryResearchEntry } from "@/types";

const partMapSchema = z.record(z.string().describe("Component category."), z.string().describe("Registry key or component name."));
const registrySpecSchema = z.object({
  brand: z.string(),
  model: z.string(),
  aliases: z.array(z.string()).default([])
}).catchall(z.unknown());
const componentSpecsSchema = z.object({
  specs: registrySpecSchema,
  sources: z.array(z.string().url()).default([])
});
const advisorySeveritySchema = z.preprocess((value) => {
  if (value === "blocking" || value === "fail" || value === "failed") return "warning";
  if (value === "pass" || value === "passed" || value === "compatible") return "ok";
  return value;
}, z.enum(["warning", "needs_verification", "ok"]));
const auditFindingSchema = z.object({
  pair: z.string().optional(),
  severity: advisorySeveritySchema,
  detail: z.string(),
  sources: z.array(z.string().url()).default([])
});
const buildAuditSchema = z.object({
  findings: z.array(auditFindingSchema).default([])
});
const freeformSchema = z.object({
  answer: z.string(),
  sources: z.array(z.string().url()).default([])
});

export type ConsultDeps = {
  searchClient?: SearchClient;
  generateText?: typeof generateTextWithFallback;
  checkCrawlerReadiness?: () => Promise<CrawlerReadiness>;
  crawlRunner?: CrawlRunner;
  /** Crawl SSRF pre-flight override (tests); defaults to DNS + redirect checks. */
  crawlPreflight?: CrawlPreflight;
  logPath?: string;
  now?: () => Date;
  /** User Stop signal for the chat turn; aborts subagent + crawl. */
  abortSignal?: AbortSignal;
  /** Per-fallback-entry LLM budget (each chain entry gets its own). */
  timeoutMsPerEntry?: number;
};

/** Registry cache TTL: researched specs go stale after 30 days. */
export const REGISTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Audit cache TTL (matches existing 14-day behaviour). */
export const AUDIT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Subagent web-tool budgets per invocation (limit consult calls per turn). */
export const MAX_SUBAGENT_SEARCH_CALLS = 8;
export const MAX_SUBAGENT_CRAWL_CALLS = 4;
/** Chat-facing source snippet budget: facts + citations, not raw pages. */
export const CHAT_SOURCE_SNIPPET_CAP = 500;

/**
 * Per-entry budget for the research subagent: one entry runs a whole tool
 * loop, so with crawling on it must also cover the worst case of every
 * crawl (pre-flight + Crawl4AI) running back to back.
 */
export function subagentEntryTimeoutMs(crawlEnabled: boolean, base = getEntryTimeoutMs()): number {
  return crawlEnabled ? base + MAX_SUBAGENT_CRAWL_CALLS * (CRAWL_PREFLIGHT_TIMEOUT_MS + CRAWL_TIMEOUT_MS) : base;
}

export function registryKey(category: string, name: string): string {
  return `${slugifyComponent(category)}:${slugifyComponent(name)}`;
}


export function createConsultInputSchema(freeformEnabled: boolean) {
  const modes = freeformEnabled
    ? (["component_specs", "build_audit", "freeform"] as const)
    : (["component_specs", "build_audit"] as const);

  const modeDesc = freeformEnabled
    ? "The operation mode: component_specs (research specs for a component), build_audit (audit build parts), or freeform (ask a general hardware question)."
    : "The operation mode: component_specs (research specs for a component) or build_audit (audit build parts).";

  return z
    .object({
      mode: z.enum(modes).describe(modeDesc),
      name: z.string().optional().describe("Used in component_specs: exact component name to research."),
      category: z.string().optional().describe("Used in component_specs: component category."),
      parts: partMapSchema.optional().describe("Used in build_audit: final build parts keyed by category."),
      question: z.string().optional().describe("Used in freeform: question to answer."),
      context: z.string().optional().describe("Used in freeform: relevant build context.")
    })
    .superRefine((data, ctx) => {
      if (data.mode === "component_specs") {
        if (!data.name || data.name.trim() === "") {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "name is required and must be a non-empty string in component_specs mode", path: ["name"] });
        }
        if (!data.category || data.category.trim() === "") {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "category is required and must be a non-empty string in component_specs mode", path: ["category"] });
        }
      } else if (data.mode === "build_audit") {
        if (!data.parts || Object.keys(data.parts).length === 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "parts is required and must be a non-empty object in build_audit mode", path: ["parts"] });
        }
      } else if ((data.mode as string) === "freeform") {
        if (!data.question || data.question.trim() === "") {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "question is required and must be a non-empty string in freeform mode", path: ["question"] });
        }
      }
    });
}

export const consultInputSchema = createConsultInputSchema(true);

export type ConsultInput =
  | { mode: "component_specs"; name: string; category: string }
  | { mode: "build_audit"; parts: Record<string, string> }
  | { mode: "freeform"; question: string; context?: string };

export function createConsultTool(config: AppConfig) {
  return tool({
    description:
      "Use consult for advisory research when validate_build reports needs_research or for hardware questions. Do not use it to clear Tier 1 blocking failures or after presenting a build. Example: {\"mode\":\"component_specs\",\"name\":\"Ryzen 7 9700X\",\"category\":\"cpu\"}.",
    inputSchema: createConsultInputSchema(Boolean(config.freeformConsultEnabled)),
    execute: async (input, options) => consult(input as ConsultInput, config, { abortSignal: options?.abortSignal })
  });
}

export async function consult(input: ConsultInput, config: AppConfig, deps: ConsultDeps = {}) {
  const crawlEnabled = Boolean(config.search.crawlEnabled);
  const search = deps.searchClient ?? createSearchClient(config.search, {
    checkCrawlerReadiness: deps.checkCrawlerReadiness,
    runPythonModule: deps.crawlRunner,
    crawlPreflight: deps.crawlPreflight
  });
  const db = getDb(config.dbPath);
  const now = deps.now ?? (() => new Date());
  if (input.mode === "component_specs") {
    const key = registryKey(input.category, input.name);
    const stmt = db.prepare("SELECT key, specs, confidence, sources, researched_at FROM registry_research WHERE key = ?");
    const existing = stmt.get(key) as (Pick<RegistryResearchEntry, "key" | "specs" | "confidence" | "sources"> & { researched_at?: string }) | undefined;
    // Migrate legacy slug-only keys (pre-category): read once, rewrite below.
    const legacy = !existing
      ? (stmt.get(slugifyComponent(input.name)) as (Pick<RegistryResearchEntry, "key" | "specs" | "confidence" | "sources"> & { researched_at?: string }) | undefined)
      : undefined;
    const hit = existing ?? legacy;
    if (hit && !isRegistryStale(hit.researched_at, Date.now())) {
      const result = { mode: input.mode, key, specs: JSON.parse(hit.specs), confidence: hit.confidence, sources: JSON.parse(hit.sources ?? "[]"), cached: true };
      await logConsult(input, result, { provider: "cache", model: "registry_research", logPath: deps.logPath });
      return result;
    }
    const grounded = await safeSearch(search, `${input.name} ${input.category} official specifications`, crawlEnabled);
    const llm = await runStructuredSubagent({
      input,
      config,
      deps,
      schema: componentSpecsSchema,
      prompt: [
        `Extract factual registry specs for this ${input.category}: ${input.name}.`,
        "Return only JSON with shape {\"specs\":{...},\"sources\":[...]}",
        "The specs object must include brand, model, aliases, and any category-relevant fields present in sources such as socket, ddr, tdp_w, wattage, length_mm, vram_gb, segment, form_factor, m2_slots, sata_ports, height_mm, sockets, tdp_rating_w, interface, capacity_gb, cooler_type, radiator_size_mm, supported_radiators, supported_psu_form_factors, max_psu_length_mm, supported_memory, modules, m2_sata_supported.",
        "Do not include compatibility verdicts.",
        "Cite only sources you actually used from the grounding context; do not invent URLs.",
        groundingBlock(grounded)
      ].join("\n\n"),
      crawlRunner: deps.crawlRunner
    });
    if (!llm.ok) {
      await logConsult(input, llm.result, { provider: llm.provider, model: llm.model, logPath: deps.logPath });
      return llm.result;
    }
    const confidence = scoreResearchConfidence(grounded, llm.data.sources, crawledUrls(llm.actions));
    const specs = { ...llm.data.specs, aliases: Array.from(new Set([input.name, ...(llm.data.specs.aliases ?? [])])) };
    // Sources actually used: the URLs the subagent cited, resolved against
    // grounding titles/snippets (truncated for chat). Raw crawled page text
    // never leaves the subagent — the chat model gets facts + citations.
    const citedSources = toCitedSources(llm.data.sources, grounded.results);
    const sourceUrls = citedSources.map((source) => source.url);
    db.prepare("INSERT OR REPLACE INTO registry_research (key, category, specs, sources, confidence, researched_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(key, input.category, JSON.stringify(specs), JSON.stringify(sourceUrls), confidence, now().toISOString());
    const result = { mode: input.mode, key, specs, sources: citedSources, actions: llm.actions, confidence, note: "Facts are researched and not community-verified; no compatibility verdict is returned." };
    await logConsult(input, result, { provider: llm.provider, model: llm.model, logPath: deps.logPath });
    return result;
  }
  if (input.mode === "build_audit") {
    const pairs = buildAuditPairs(input.parts);
    const cached = pairs.flatMap((pair) => {
      const row = db.prepare("SELECT verdict, checked_at FROM audit_cache WHERE pair_key = ?").get(pair) as Pick<AuditCacheEntry, "verdict" | "checked_at"> | undefined;
      if (!row || Date.now() - Date.parse(row.checked_at) > AUDIT_TTL_MS) return [];
      return [{ pair, ...JSON.parse(row.verdict), cached: true }];
    });
    const fresh = pairs.filter((pair) => !cached.some((item) => item.pair === pair));
    if (fresh.length === 0) {
      const result = { mode: input.mode, verdicts: cached.map((item) => sanitizeAuditFinding(item, item.pair)), authority: "advisory_only" };
      await logConsult(input, result, { provider: "cache", model: "audit_cache", logPath: deps.logPath });
      return result;
    }
    const freshResults = await Promise.all(fresh.map(async (pair) => {
      const grounded = await safeSearch(search, `${pair} PC compatibility BIOS QVL connector known issues`, crawlEnabled);
      const llm = await runStructuredSubagent({
        input,
        config,
        deps,
        schema: buildAuditSchema,
        prompt: [
          `Audit only this component pair for advisory PC build concerns: ${pair}.`,
          "Return only JSON with shape {\"findings\":[{\"severity\":\"warning|needs_verification|ok\",\"detail\":\"...\",\"sources\":[...]}]}.",
          "You cannot approve compatibility, clear Tier 1 failures, or emit blocking/pass verdicts.",
          "Focus on BIOS/VRM, QVL, PSU connector, PCIe generation, and known edge-case concerns.",
          "Cite only sources you actually used; an empty findings array means no concerns found.",
          groundingBlock(grounded)
        ].join("\n\n"),
        crawlRunner: deps.crawlRunner
      });
      let verdict;
      if (llm.ok) {
        verdict = mergeAuditFindings(llm.data.findings, pair, grounded.results);
        db.prepare("INSERT OR REPLACE INTO audit_cache (pair_key, verdict, checked_at) VALUES (?, ?, ?)").run(pair, JSON.stringify(verdict), now().toISOString());
      } else {
        verdict = { severity: "needs_verification", detail: `Advisory audit unavailable for ${pair}: ${llm.result.error}`, sources: [] };
      }
      return { ...verdict, pair, cached: false, provider: llm.provider, model: llm.model };
    }));
    cached.push(...freshResults);
    const servedBy = freshResults.map((item) => ({ provider: item.provider, model: item.model }));
    const result = { mode: input.mode, verdicts: cached.map((item) => sanitizeAuditFinding(item, item.pair)), authority: "advisory_only" };
    await logConsult(input, result, {
      provider: servedBy.length ? Array.from(new Set(servedBy.map((served) => served.provider))).join(",") : "cache",
      model: servedBy.length ? Array.from(new Set(servedBy.map((served) => served.model))).join(",") : "audit_cache",
      logPath: deps.logPath
    });
    return result;
  }
  if (!config.freeformConsultEnabled) return { error: "freeform consult is disabled", hint: "enable PCBUILDSAGE_CONSULT_FREEFORM or use component_specs/build_audit" };
  const grounded = await safeSearch(search, input.question, crawlEnabled);
  const llm = await runStructuredSubagent({
    input,
    config,
    deps,
    schema: freeformSchema,
    prompt: [
      `Answer this PC hardware question as an unverified advisory note: ${input.question}`,
      input.context ? `Context: ${input.context}` : "",
      "Return only JSON with shape {\"answer\":\"...\",\"sources\":[...]}",
      "Do not assert compatibility authority or clear deterministic rule failures.",
      groundingBlock(grounded)
    ].filter(Boolean).join("\n\n"),
    crawlRunner: deps.crawlRunner
  });
  const result = llm.ok
    ? { mode: input.mode, severity: "needs_verification", answer: llm.data.answer, note: "Uncached advisory answer; not fed to deterministic rules.", sources: toCitedSources(llm.data.sources, grounded.results), source_urls: llm.data.sources, label: "unverified" }
    : llm.result;
  await logConsult(input, result, { provider: llm.provider, model: llm.model, logPath: deps.logPath });
  return result;
}

function buildAuditPairs(parts: Record<string, string>) {
  return [
    parts.cpu && parts.motherboard ? `cpu:${parts.cpu}|motherboard:${parts.motherboard}` : undefined,
    parts.ram && parts.motherboard ? `ram:${parts.ram}|motherboard:${parts.motherboard}` : undefined,
    parts.gpu && parts.psu ? `gpu:${parts.gpu}|psu:${parts.psu}` : undefined
  ].filter((pair): pair is string => Boolean(pair));
}

async function safeSearch(search: SearchClient, query: string, crawlEnabled?: boolean): Promise<SearchResponse> {
  try {
    const res = await search.search(query, { limit: 5, crawlEnabled });
    if (res.error) {
      res.error = sanitizeConsultText(res.error);
    }
    return res;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { provider: "none", grounded: false, results: [], error: sanitizeConsultText(errorMsg) };
  }
}

function groundingBlock(grounded: SearchResponse) {
  if (grounded.error) {
    return `Grounding context: search failed (${grounded.error}). Still answer if possible, but do not invent sources.`;
  }
  if (!grounded.results.length) return "Grounding context: none configured or no search results. Still answer, but do not invent sources.";
  return `Grounding context from ${grounded.provider}:\n${grounded.results.map(formatSource).join("\n")}`;
}

function formatSource(result: SearchResult, index: number) {
  return `[${index + 1}] ${result.title}\nURL: ${result.url}\nSnippet: ${result.snippet}`;
}

export type SubagentAction = {
  tool: "search_web" | "crawl_page";
  query?: string;
  url?: string;
  resultCount?: number;
  error?: string;
};

function createSubagentTools(
  search: SearchClient,
  crawlRunner?: CrawlRunner,
  onAction?: (action: SubagentAction) => void,
  crawlerChecker?: () => Promise<CrawlerReadiness>,
  crawlEnabled = false,
  options?: { abortSignal?: AbortSignal; searchCalls?: { count: number }; crawlCalls?: { count: number }; crawlPreflight?: CrawlPreflight }
): ToolSet {
  const searchCalls = options?.searchCalls ?? { count: 0 };
  const crawlCalls = options?.crawlCalls ?? { count: 0 };
  return {
    search_web: tool({
      description: "Search the web for PC hardware component specifications, official datasheets, physical dimensions, TDP, and power requirements.",
      inputSchema: z.object({
        query: z.string().describe("Search query, e.g. 'Gigabyte RTX 5070 Aorus Master length mm tdp power'")
      }),
      execute: async ({ query }) => {
        if (options?.abortSignal?.aborted) return { results: [], error: "Research was cancelled." };
        if (searchCalls.count >= MAX_SUBAGENT_SEARCH_CALLS) {
          const errorMsg = `Search budget exhausted (${MAX_SUBAGENT_SEARCH_CALLS} calls per subagent turn).`;
          onAction?.({ tool: "search_web", query, error: errorMsg });
          return { results: [], error: errorMsg };
        }
        searchCalls.count += 1;
        try {
          const res = await safeSearch(search, query, false);
          // safeSearch already redacts; do not sanitize twice.
          onAction?.({ tool: "search_web", query, resultCount: res.results.length, error: res.error });
          return { results: res.results, error: res.error };
        } catch (err) {
          const errorMsg = sanitizeConsultText(err instanceof Error ? err.message : String(err));
          onAction?.({ tool: "search_web", query, error: errorMsg });
          return { results: [], error: errorMsg };
        }
      }
    }),
    crawl_page: tool({
      description: "Fetch full text and spec tables from a specific URL discovered in web search (e.g. manufacturer spec page or TechPowerUp).",
      inputSchema: z.object({
        url: z.string().url().describe("Exact webpage URL to crawl")
      }),
      execute: async ({ url }, toolOptions) => {
        const signal = toolOptions?.abortSignal ?? options?.abortSignal;
        if (signal?.aborted) {
          const errorMsg = "Page crawl was cancelled.";
          onAction?.({ tool: "crawl_page", url, error: errorMsg });
          return { error: errorMsg };
        }
        if (crawlCalls.count >= MAX_SUBAGENT_CRAWL_CALLS) {
          const errorMsg = `Crawl budget exhausted (${MAX_SUBAGENT_CRAWL_CALLS} pages per subagent turn).`;
          onAction?.({ tool: "crawl_page", url, error: errorMsg });
          return { error: errorMsg };
        }
        // Allow only http/https; block private/loopback. crawlPage adds the
        // DNS + redirect-chain pre-flight.
        try {
          assertCrawlUrlAllowed(url);
        } catch (err) {
          const errorMsg = sanitizeConsultText(err instanceof Error ? err.message : String(err));
          onAction?.({ tool: "crawl_page", url, error: errorMsg });
          return { error: errorMsg };
        }
        if (!crawlEnabled) {
          const errorMsg = "Page crawling is disabled. Web search is available.";
          onAction?.({ tool: "crawl_page", url, error: errorMsg });
          return { error: errorMsg };
        }
        const checker = crawlerChecker ?? checkCrawlerReadiness;
        const readiness = await checker();
        if (!readiness.ready) {
          const errorMsg = crawlUnavailableMessage(readiness.reason);
          onAction?.({ tool: "crawl_page", url, error: errorMsg });
          return { error: errorMsg };
        }
        crawlCalls.count += 1;
        try {
          const runner = crawlRunner ?? runPythonModule;
          const content = await crawlPage(url, runner, { signal, preflight: options?.crawlPreflight });
          onAction?.({ tool: "crawl_page", url });
          // Capped at CRAWLED_PAGE_CAP_CHARS before the subagent sees it.
          return { content: content.slice(0, CRAWLED_PAGE_CAP_CHARS) };
        } catch (err) {
          const rawMsg = err instanceof Error ? err.message : String(err);
          const errorMsg = sanitizeConsultText(rawMsg);
          onAction?.({ tool: "crawl_page", url, error: errorMsg });
          return { error: errorMsg };
        }
      }
    })
  };
}

export function sanitizeConsultText(text: string): string {
  let redacted = text
    .replace(/\bAIza[0-9A-Za-z-_]{20,}\b/g, "[REDACTED]")
    .replace(/\bgsk_[0-9A-Za-z]{10,}\b/g, "[REDACTED]")
    .replace(/\bsk-(?:or-v1-|ant-)?[0-9A-Za-z-_]{15,}\b/g, "[REDACTED]")
    .replace(/\btvly-[0-9A-Za-z-_]{10,}\b/g, "[REDACTED]")
    .replace(/\bBSA[0-9A-Za-z-_]{10,}\b/g, "[REDACTED]")
    .replace(/\bexa_[0-9A-Za-z]{8,}\b/gi, "[REDACTED]")
    .replace(/\bbrave-[0-9A-Za-z-_]{10,}\b/gi, "[REDACTED]")
    .replace(/\bexa-[0-9A-Za-z-_]{10,}\b/gi, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:api[_-]?key|key)=)[^&\s]+/gi, "$1[REDACTED]");
  // Redact live values of known .env keys so echoing config never leaks them.
  for (const envKey of ["GEMINI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY", "OPENAI_COMPATIBLE_API_KEY", "OLLAMA_API_KEY", "EXA_API_KEY", "TAVILY_API_KEY", "BRAVE_API_KEY", "SEARXNG_BASE_URL"]) {
    const value = process.env[envKey];
    if (value && value.length >= 8 && redacted.includes(value)) {
      redacted = redacted.split(value).join("[REDACTED]");
    }
  }
  return redacted;
}

export type ClassifiedConsultError = {
  type: "rejected_credentials" | "timeout" | "missing_setup" | "quota_exceeded" | "service_failure" | "unknown";
  message: string;
  detail?: string;
  isTerminal: boolean;
};

export function classifyConsultError(error: unknown): ClassifiedConsultError {
  let rawMsg = "";
  if (error && typeof error === "object" && "errors" in error && Array.isArray((error as { errors: unknown[] }).errors)) {
    const childErrors = (error as { errors: unknown[] }).errors.map((e) => (e instanceof Error ? e.message : String(e)));
    rawMsg = childErrors.join("; ") || ((error as { message?: string }).message ?? "");
  } else if (error instanceof Error) {
    rawMsg = error.message;
  } else {
    rawMsg = String(error ?? "Unknown error");
  }

  const sanitized = sanitizeConsultText(rawMsg);
  const lower = sanitized.toLowerCase();

  // 1. Timeout
  if (
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("deadline exceeded") ||
    lower.includes("aborted") ||
    lower.includes("signal is aborted")
  ) {
    return {
      type: "timeout",
      message: "Research timed out. Specifications remain unverified.",
      detail: sanitized,
      isTerminal: true
    };
  }

  // 2. Rejected credentials
  if (
    lower.includes("unauthorized") ||
    /\b(401|403)\b/.test(lower) ||
    lower.includes("forbidden") ||
    lower.includes("invalid api key") ||
    lower.includes("api key not valid") ||
    lower.includes("authentication failed") ||
    lower.includes("unauthenticated")
  ) {
    return {
      type: "rejected_credentials",
      message: "Research provider rejected the API key. Update it in Settings.",
      detail: sanitized,
      isTerminal: true
    };
  }

  // 3. Quota exceeded
  const has429 = /\b429\b/.test(lower);
  if (
    has429 ||
    lower.includes("quota") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("free-models-per-day") ||
    lower.includes("resource has been exhausted")
  ) {
    const codeHint = has429 ? " (429)" : "";
    return {
      type: "quota_exceeded",
      message: `Research quota exceeded${codeHint}. Specifications remain unverified.`,
      detail: sanitized,
      isTerminal: true
    };
  }

  // 4. Missing setup
  if (
    lower.includes("not configured") ||
    lower.includes("api key is required") ||
    lower.includes("missing api key")
  ) {
    return {
      type: "missing_setup",
      message: "Research provider is not configured. Update it in Settings.",
      detail: sanitized,
      isTerminal: true
    };
  }

  // 5. Service / network failure
  if (
    /\b(50[0-4])\b/.test(lower) ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed") ||
    lower.includes("network error") ||
    lower.includes("service unavailable") ||
    lower.includes("overloaded")
  ) {
    return {
      type: "service_failure",
      message: "Research service unavailable. Specifications remain unverified.",
      detail: sanitized,
      isTerminal: false
    };
  }

  return {
    type: "unknown",
    message: sanitized,
    detail: sanitized,
    isTerminal: false
  };
}

async function runStructuredSubagent<T extends z.ZodTypeAny>(args: {
  input: ConsultInput;
  config: AppConfig;
  deps: ConsultDeps;
  schema: T;
  prompt: string;
  crawlRunner?: CrawlRunner;
}): Promise<
  | { ok: true; data: z.infer<T>; provider: string; model: string; actions: SubagentAction[] }
  | { ok: false; result: { mode: ConsultInput["mode"]; error: string; detail?: string; retryable: false; label: "unverified"; actions?: SubagentAction[] }; provider: string; model: string }
> {
  const generate = args.deps.generateText ?? generateTextWithFallback;
  const search = args.deps.searchClient ?? createSearchClient(args.config.search, {
    checkCrawlerReadiness: args.deps.checkCrawlerReadiness,
    runPythonModule: args.crawlRunner,
    crawlPreflight: args.deps.crawlPreflight
  });
  const actions: SubagentAction[] = [];
  // Per-turn tool budgets: the chat model gets facts, not unlimited browsing.
  const budgets = { search: { count: 0 }, crawl: { count: 0 } };
  const tools = createSubagentTools(
    search,
    args.crawlRunner,
    (act) => actions.push(act),
    args.deps.checkCrawlerReadiness,
    Boolean(args.config.search.crawlEnabled),
    { abortSignal: args.deps.abortSignal, searchCalls: budgets.search, crawlCalls: budgets.crawl, crawlPreflight: args.deps.crawlPreflight }
  );
  let provider = "unknown";
  let model = "unknown";
  let lastError = "Model did not return valid JSON.";
  let lastDetail: string | undefined;
  let lastGeneratedText: string | undefined;
  // Timing is per fallback entry (timeoutMsPerEntry): each chain entry gets
  // its full budget. Only the user Stop signal is passed as abortSignal —
  // a chain-wide timeout signal would make the client treat an entry
  // timeout as user Stop and skip the fallback entries.
  const entryTimeout = args.deps.timeoutMsPerEntry ?? subagentEntryTimeoutMs(Boolean(args.config.search.crawlEnabled));
  const repairTimeout = Math.min(args.deps.timeoutMsPerEntry ?? getEntryTimeoutMs(), 15_000);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (args.deps.abortSignal?.aborted) {
      lastError = "Research was cancelled.";
      break;
    }
    try {
      if (attempt === 0) {
        const response = await generate({
          chain: args.config.llm.roles.subagent,
          system: "You are an isolated PCBuildSage Tier 2 research subagent. You have tools to search the web and crawl pages for technical specifications. After gathering the necessary facts, output the final result strictly as a valid JSON object matching the requested schema. No markdown formatting outside the JSON.",
          prompt: args.prompt,
          tools,
          stopWhen: isStepCount(5),
          abortSignal: args.deps.abortSignal,
          timeoutMsPerEntry: entryTimeout
        });
        provider = response.provider;
        model = response.model;
        lastGeneratedText = response.text;

        const parsed = parseJsonObject(response.text);
        const validated = args.schema.safeParse(parsed);
        if (validated.success) return { ok: true, data: validated.data, provider, model, actions };
        lastError = validated.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      } else {
        // Attempt 1: Narrow JSON repair without repeating web research tools
        if (!lastGeneratedText) break;
        const repairPrompt = `Original request and grounding:\n${args.prompt}\n\nPrevious response failed JSON/schema validation: ${lastError}\n\nPrevious output:\n${lastGeneratedText}\n\nReformat and extract strictly valid JSON matching the schema. Return corrected JSON only.`;
        const response = await generate({
          chain: args.config.llm.roles.subagent,
          system: "You are an isolated PCBuildSage Tier 2 research subagent. Your task is strictly JSON repair. Output only valid JSON matching the requested schema without markdown wrapper.",
          prompt: repairPrompt,
          stopWhen: isStepCount(2),
          abortSignal: args.deps.abortSignal,
          timeoutMsPerEntry: repairTimeout
        });
        provider = response.provider;
        model = response.model;

        const parsed = parseJsonObject(response.text);
        const validated = args.schema.safeParse(parsed);
        if (validated.success) return { ok: true, data: validated.data, provider, model, actions };
        lastError = validated.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      }
    } catch (error) {
      if (args.deps.abortSignal?.aborted) {
        lastError = "Research was cancelled.";
        lastDetail = undefined;
        break;
      }
      const classified = classifyConsultError(error);
      lastError = classified.message;
      lastDetail = classified.detail;
      if (classified.isTerminal) {
        // Stop immediately on terminal credentials, quota, or timeout errors - do not retry
        break;
      }
    }
  }
  return { ok: false, provider, model, result: { mode: args.input.mode, error: lastError, detail: lastDetail, retryable: false, label: "unverified", actions } };
}

/** URLs the subagent crawled successfully (a crawl action without an error). */
function crawledUrls(actions: SubagentAction[]): string[] {
  return actions.flatMap((action) => (action.tool === "crawl_page" && action.url && !action.error ? [action.url] : []));
}

export function isRegistryStale(researchedAt: string | undefined, nowMs: number): boolean {
  // Legacy rows without a timestamp stay a hit (backward compatible with
  // existing caches and test fixtures); new rows carry researched_at for TTL.
  if (!researchedAt) return false;
  const parsed = Date.parse(researchedAt);
  if (!Number.isFinite(parsed)) return true;
  return nowMs - parsed > REGISTRY_TTL_MS;
}

/**
 * Confidence from source quality, not just presence: high needs multiple
 * grounding hits plus a cited source we can verify (it appears in the
 * grounding results or was actually crawled), medium needs grounding, else
 * low. Model-cited URLs we never saw do not count.
 */
export function scoreResearchConfidence(grounded: SearchResponse, citedUrls: string[], crawled: string[] = []): "high" | "medium" | "low" {
  const known = new Set([...grounded.results.map((result) => result.url.trim()), ...crawled.map((url) => url.trim())]);
  const verified = (citedUrls ?? []).map((url) => url.trim()).filter((url) => url && known.has(url));
  if (grounded.grounded && grounded.results.length >= 2 && verified.length >= 1) return "high";
  if (grounded.grounded && grounded.results.length >= 1) return "medium";
  return "low";
}

/**
 * Sources actually used: the URLs the subagent cited, with titles/snippets
 * resolved from grounding and truncated for chat. Raw crawled page text is
 * never returned — only facts plus citations.
 */
export function toCitedSources(citedUrls: string[], grounded: SearchResult[]): Array<{ url: string; title?: string; snippet?: string }> {
  const byUrl = new Map(grounded.map((result) => [result.url, result]));
  const seen = new Set<string>();
  const cited: Array<{ url: string; title?: string; snippet?: string }> = [];
  for (const raw of citedUrls ?? []) {
    const url = typeof raw === "string" ? raw.trim() : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const match = byUrl.get(url);
    cited.push({
      url,
      ...(match?.title ? { title: match.title } : {}),
      ...(match?.snippet ? { snippet: match.snippet.slice(0, CHAT_SOURCE_SNIPPET_CAP) } : {})
    });
  }
  // Fall back to grounding when the model cited nothing usable.
  if (cited.length === 0) {
    for (const result of grounded.slice(0, 3)) {
      if (seen.has(result.url)) continue;
      seen.add(result.url);
      cited.push({ url: result.url, title: result.title, snippet: result.snippet.slice(0, CHAT_SOURCE_SNIPPET_CAP) });
    }
  }
  return cited;
}

/**
 * Merge one pair's findings: empty means no concerns (ok with a note),
 * multiple are combined with the highest severity winning.
 */
export function mergeAuditFindings(findings: unknown, pair: string, grounded?: SearchResult[]) {
  const list = Array.isArray(findings) ? findings : [];
  const parsed = list
    .map((finding) => auditFindingSchema.safeParse(finding))
    .filter((result): result is Extract<typeof result, { success: true }> => result.success)
    .map((result) => result.data);
  if (parsed.length === 0) {
    if (list.length === 0) {
      return { pair, severity: "ok" as const, detail: `No advisory concerns found for ${pair}; Tier 1 validation still applies.`, sources: [] };
    }
    return { pair, severity: "needs_verification" as const, detail: `Advisory audit for ${pair} needs verification; malformed model finding was discarded.`, sources: [] };
  }
  const rank = { warning: 3, needs_verification: 2, ok: 1 } as const;
  const top = parsed.reduce((best, current) => (rank[current.severity] > rank[best.severity] ? current : best));
  const details = parsed.length === 1 ? top.detail : parsed.map((finding) => `- [${finding.severity}] ${finding.detail}`).join("\n");
  const sources = Array.from(new Set(parsed.flatMap((finding) => finding.sources))).slice(0, 5);
  void grounded;
  const detail = top.severity === "ok" && parsed.length === 1
    ? `${top.detail} This advisory result does not clear Tier 1 validation.`
    : details;
  return { pair, severity: top.severity, detail, sources };
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON object found in model response.");
    return JSON.parse(match[0]);
  }
}

function sanitizeAuditFinding(finding: unknown, pair: string) {
  const parsed = auditFindingSchema.safeParse(finding);
  if (!parsed.success) {
    return { pair, severity: "needs_verification" as const, detail: `Advisory audit for ${pair} needs verification; malformed model finding was discarded.`, sources: [] };
  }
  return {
    pair,
    severity: parsed.data.severity,
    detail: parsed.data.severity === "ok" ? `${parsed.data.detail} This advisory result does not clear Tier 1 validation.` : parsed.data.detail,
    sources: parsed.data.sources
  };
}

async function logConsult(input: ConsultInput, result: unknown, served: { provider: string; model: string; logPath?: string }): Promise<void> {
  await appendChatLog({
    role: "tool",
    toolName: "consult",
    toolArgs: input,
    toolResult: summarizeConsultResult(result),
    provider: served.provider,
    modelId: served.model
  }, served.logPath);
}

function summarizeConsultResult(result: unknown) {
  if (typeof result !== "object" || result === null) return result;
  const value = result as Record<string, unknown>;
  return {
    mode: value.mode,
    cached: value.cached,
    confidence: value.confidence,
    authority: value.authority,
    error: value.error,
    result_count: Array.isArray(value.verdicts) ? value.verdicts.length : undefined,
    has_specs: Boolean(value.specs),
    source_count: Array.isArray(value.sources) ? value.sources.length : undefined
  };
}
