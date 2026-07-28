import { tool } from "ai";
import { z } from "zod";
import { getDb } from "../db";
import { generateTextWithFallback } from "../llm-client";
import { appendChatLog } from "../logger";
import { slugifyComponent } from "../normalizer";
import { createSearchClient, type SearchClient, type SearchResponse, type SearchResult } from "../web-search";
import type { AppConfig } from "../config-types";
import type { AuditCacheEntry, RegistryResearchEntry } from "../db-types";

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

type ConsultDeps = {
  searchClient?: SearchClient;
  generateText?: typeof generateTextWithFallback;
  logPath?: string;
  now?: () => Date;
};

const modeDescription = "The operation mode: component_specs (research specs for a component), build_audit (audit build parts), or freeform (ask a general hardware question).";

export const consultInputSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("component_specs").describe(modeDescription),
    name: z.string().refine((value) => value.trim() !== "", {
      message: "name is required and must be a non-empty string in component_specs mode"
    }).describe("Used in component_specs: exact component name to research."),
    category: z.string().refine((value) => value.trim() !== "", {
      message: "category is required and must be a non-empty string in component_specs mode"
    }).describe("Used in component_specs: component category.")
  }),
  z.object({
    mode: z.literal("build_audit").describe(modeDescription),
    parts: partMapSchema.refine((value) => Object.keys(value).length > 0, {
      message: "parts is required and must be a non-empty object in build_audit mode"
    }).describe("Used in build_audit: final build parts keyed by category.")
  }),
  z.object({
    mode: z.literal("freeform").describe(modeDescription),
    question: z.string().refine((value) => value.trim() !== "", {
      message: "question is required and must be a non-empty string in freeform mode"
    }).describe("Used in freeform: question to answer."),
    context: z.string().optional().describe("Used in freeform: relevant build context.")
  })
]);

export type ConsultInput = z.infer<typeof consultInputSchema>;

export function createConsultTool(config: AppConfig) {
  return tool({
    description:
      "Use consult only for Tier 2 advisory work. Use component_specs when validate_build reports needs_research; use build_audit once on a final build; do not use it to clear Tier 1 blocking failures. Example: {\"mode\":\"component_specs\",\"name\":\"Ryzen 7 9700X\",\"category\":\"cpu\"}.",
    inputSchema: consultInputSchema,
    execute: async (input) => consult(input as ConsultInput, config)
  });
}

export async function consult(input: ConsultInput, config: AppConfig, deps: ConsultDeps = {}) {
  const search = deps.searchClient ?? createSearchClient(config.search);
  const db = getDb(config.dbPath);
  const now = deps.now ?? (() => new Date());
  if (input.mode === "component_specs") {
    const key = slugifyComponent(input.name);
    const existing = db.prepare("SELECT key, specs, confidence, sources FROM registry_research WHERE key = ?").get(key) as Pick<RegistryResearchEntry, "key" | "specs" | "confidence" | "sources"> | undefined;
    if (existing) {
      const result = { mode: input.mode, key, specs: JSON.parse(existing.specs), confidence: existing.confidence, sources: JSON.parse(existing.sources ?? "[]"), cached: true };
      await logConsult(input, result, { provider: "cache", model: "registry_research", logPath: deps.logPath });
      return result;
    }
    const grounded = await safeSearch(search, `${input.name} ${input.category} official specifications`, config.search.crawlEnabled);
    const llm = await runStructuredSubagent({
      input,
      config,
      deps,
      schema: componentSpecsSchema,
      prompt: [
        `Extract factual registry specs for this ${input.category}: ${input.name}.`,
        "Return only JSON with shape {\"specs\":{...},\"sources\":[...]}",
        "The specs object must include brand, model, aliases, and any category-relevant fields present in sources such as socket, ddr, tdp_w, wattage, length_mm, vram_gb, segment, form_factor, m2_slots, sata_ports, height_mm, sockets, tdp_rating_w, interface, capacity_gb.",
        "Do not include compatibility verdicts.",
        groundingBlock(grounded)
      ].join("\n\n")
    });
    if (!llm.ok) {
      await logConsult(input, llm.result, { provider: llm.provider, model: llm.model, logPath: deps.logPath });
      return llm.result;
    }
    const confidence = grounded.grounded && grounded.results.length ? "medium" : "low";
    const specs = { ...llm.data.specs, aliases: Array.from(new Set([input.name, ...(llm.data.specs.aliases ?? [])])) };
    const sourceUrls = Array.from(new Set([...grounded.results.map((result) => result.url), ...llm.data.sources]));
    db.prepare("INSERT OR REPLACE INTO registry_research (key, category, specs, sources, confidence, researched_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(key, input.category, JSON.stringify(specs), JSON.stringify(sourceUrls), confidence, now().toISOString());
    const result = { mode: input.mode, key, specs, sources: grounded.results, confidence, note: "Facts are researched and not community-verified; no compatibility verdict is returned." };
    await logConsult(input, result, { provider: llm.provider, model: llm.model, logPath: deps.logPath });
    return result;
  }
  if (input.mode === "build_audit") {
    const pairs = buildAuditPairs(input.parts);
    const cached = pairs.flatMap((pair) => {
      const row = db.prepare("SELECT verdict, checked_at FROM audit_cache WHERE pair_key = ?").get(pair) as Pick<AuditCacheEntry, "verdict" | "checked_at"> | undefined;
      if (!row || Date.now() - Date.parse(row.checked_at) > 14 * 24 * 60 * 60 * 1000) return [];
      return [{ pair, ...JSON.parse(row.verdict), cached: true }];
    });
    const fresh = pairs.filter((pair) => !cached.some((item) => item.pair === pair));
    const freshResults = await Promise.all(fresh.map(async (pair) => {
      const grounded = await safeSearch(search, `${pair} PC compatibility BIOS QVL connector known issues`, config.search.crawlEnabled);
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
          groundingBlock(grounded)
        ].join("\n\n")
      });
      let verdict;
      if (llm.ok) {
        verdict = sanitizeAuditFinding(llm.data.findings[0], pair);
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
  const grounded = await safeSearch(search, input.question, config.search.crawlEnabled);
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
    ].filter(Boolean).join("\n\n")
  });
  const result = llm.ok
    ? { mode: input.mode, severity: "needs_verification", answer: llm.data.answer, note: "Uncached advisory answer; not fed to deterministic rules.", sources: grounded.results, source_urls: llm.data.sources, label: "unverified" }
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
    return await search.search(query, { limit: 5, crawlEnabled });
  } catch {
    return { provider: "none", grounded: false, results: [] };
  }
}

function groundingBlock(grounded: SearchResponse) {
  if (!grounded.results.length) return "Grounding context: none configured or no search results. Still answer, but do not invent sources.";
  return `Grounding context from ${grounded.provider}:\n${grounded.results.map(formatSource).join("\n")}`;
}

function formatSource(result: SearchResult, index: number) {
  return `[${index + 1}] ${result.title}\nURL: ${result.url}\nSnippet: ${result.snippet}`;
}

async function runStructuredSubagent<T extends z.ZodTypeAny>(args: {
  input: ConsultInput;
  config: AppConfig;
  deps: ConsultDeps;
  schema: T;
  prompt: string;
}): Promise<
  | { ok: true; data: z.infer<T>; provider: string; model: string }
  | { ok: false; result: { mode: ConsultInput["mode"]; error: string; retryable: false; label: "unverified" }; provider: string; model: string }
> {
  const generate = args.deps.generateText ?? generateTextWithFallback;
  let provider = "unknown";
  let model = "unknown";
  let lastError = "Model did not return valid JSON.";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await generate({
        chain: args.config.llm.roles.subagent,
        system: "You are an isolated PCBuildSage Tier 2 subagent. Respond with JSON only. No markdown.",
        prompt: attempt === 0 ? args.prompt : `${args.prompt}\n\nPrevious response failed JSON/schema validation: ${lastError}\nReturn corrected JSON only.`
      });
      provider = response.provider;
      model = response.model;
      const parsed = parseJsonObject(response.text);
      const validated = args.schema.safeParse(parsed);
      if (validated.success) return { ok: true, data: validated.data, provider, model };
      lastError = validated.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ok: false, provider, model, result: { mode: args.input.mode, error: lastError, retryable: false, label: "unverified" } };
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
