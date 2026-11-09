#!/usr/bin/env tsx
/**
 * scripts/eval-recommendations.ts
 *
 * Runs the fixed buyer prompts in evals/recommendations/cases.json headless
 * through the real chat engine and scores every presented build by code
 * (scripts/eval-recommendations-score.ts). Writes results.json (full builds and
 * turn text, local only) and scorecard.md (scores only) to logs/evals/<run>/.
 *
 * Usage: npx tsx scripts/eval-recommendations.ts --model <id> --db <catalog.db>
 *          [--cases evals/recommendations/cases.json] [--only <id>[,<id>]] [--out <dir>]
 *          [--timeout-min 10] [--concurrency 1] [--retries 2] [--retry-wait-s 90]
 *
 * The model is reached as an OpenAI-compatible endpoint: set
 * OPENAI_COMPATIBLE_BASE_URL and OPENAI_COMPATIBLE_API_KEY in the environment.
 * Each case is aborted after --timeout-min; --concurrency runs that many cases
 * at once (each turn sends about one request per step, so mind the provider's
 * rate limit). A case that ends on a provider error with no build re-runs up
 * to --retries times after --retry-wait-s. Re-running with the same --out skips cases already in its
 * results.json, so an interrupted run resumes; saved turns are re-scored with
 * the current scorer, and results outside --only are kept.
 */

import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { resolveConfig } from "../src/lib/config";
import { streamChat } from "../src/lib/llm/chat-engine";
import { discoverModels } from "../src/lib/llm/discovery";
import type { LLMChainEntry } from "../src/types";
import { createAskTurnCollector, type AskStreamPart, type AskTurn } from "../src/cli/ask-turn";
import { formatScorecard, scoreCase, type CaseScore, type CatalogLookup, type CatalogRow, type EvalCase } from "./eval-recommendations-score";

/** One tool event of a turn, kept in results.json (local only) to see why a case failed. */
type TraceEvent = { step: number; tool: string; call?: string; raw?: string; result?: string; error?: string };
type CaseResult = CaseScore & { turn: AskTurn; timedOut: boolean; trace?: TraceEvent[] };

const clip = (value: unknown, max: number) => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/** The gist of a tool result: validate_build per-label verdicts, search hit counts, else a clipped dump. */
function summarizeResult(tool: string, output: unknown): string {
  const out = output && typeof output === "object" && "value" in output ? (output as { value: unknown }).value : output;
  if (tool === "validate_build" && out && typeof out === "object" && "builds" in out) {
    const builds = (out as { builds: Record<string, { valid?: boolean; issues?: Array<{ severity?: string; rule?: string; detail?: string }>; snapshot?: { total?: number | null }; not_purchasable?: unknown[] }> }).builds;
    return Object.entries(builds)
      .map(([label, b]) => `${label}: ${b.valid ? "valid" : "INVALID"}${b.not_purchasable?.length ? " NOT-PURCHASABLE" : ""} total=${b.snapshot?.total ?? "?"}${(b.issues ?? []).filter((i) => i.severity === "blocking").map((i) => ` [${clip(i.detail ?? i.rule, 160)}]`).join("")}`)
      .join(" | ");
  }
  if (out && typeof out === "object" && Array.isArray((out as { results?: unknown }).results)) {
    const o = out as { results: unknown[]; message?: string };
    return `${o.results.length} results${o.message ? ` — ${clip(o.message, 200)}` : ""}`;
  }
  return clip(out, 400);
}

/**
 * Records tool calls, results and errors per step from the chat stream. A
 * call's `raw` is the arguments text as the provider streamed it, kept when
 * the schema's parse changed it (stripped keys, coerced values).
 */
function createTraceRecorder() {
  const events: TraceEvent[] = [];
  const rawInputs = new Map<string, string>();
  let step = 0;
  const observe = (part: { type: string; [key: string]: unknown }) => {
    const tool = String(part.toolName ?? "");
    if (part.type === "finish-step") step += 1;
    else if (part.type === "tool-input-start") rawInputs.set(String(part.id), "");
    else if (part.type === "tool-input-delta") rawInputs.set(String(part.id), (rawInputs.get(String(part.id)) ?? "") + String(part.delta ?? ""));
    else if (part.type === "tool-call") {
      const raw = rawInputs.get(String(part.toolCallId));
      rawInputs.delete(String(part.toolCallId));
      const changed = raw !== undefined && raw.trim() !== "" && raw.replace(/\s+/g, "") !== JSON.stringify(part.input);
      events.push({ step, tool, call: clip(part.input, 1500), ...(changed ? { raw: clip(raw, 3000) } : {}) });
    }
    else if (part.type === "tool-result") events.push({ step, tool, result: summarizeResult(tool, part.output) });
    else if (part.type === "tool-error") events.push({ step, tool, error: clip(part.error instanceof Error ? part.error.message : part.error, 1500) });
  };
  return { observe, events };
}

/** The endpoint's reported context size for the model: its own row, or the only row a single-model server lists. */
async function discoveredContextLimit(entry: LLMChainEntry): Promise<number | undefined> {
  try {
    const models = await discoverModels(entry);
    return (models.find((m) => m.id === entry.model) ?? (models.length === 1 ? models[0] : undefined))?.contextLimit;
  } catch {
    return undefined;
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      model: { type: "string" },
      db: { type: "string" },
      cases: { type: "string", default: "evals/recommendations/cases.json" },
      only: { type: "string" },
      out: { type: "string" },
      "timeout-min": { type: "string", default: "10" },
      concurrency: { type: "string", default: "1" },
      retries: { type: "string", default: "2" },
      "retry-wait-s": { type: "string", default: "90" },
      "context-limit": { type: "string" }
    }
  });
  const retries = Number(values.retries);
  if (!Number.isInteger(retries) || retries < 0) throw new Error(`--retries must be a whole number >= 0, got "${values.retries}"`);
  const retryWaitS = positiveNumber(values["retry-wait-s"], "--retry-wait-s");
  const model = values.model;
  if (!model || !values.db) throw new Error("Usage: eval-recommendations --model <id> --db <catalog.db> [--cases <file>] [--only <id>] [--out <dir>] [--timeout-min 10] [--concurrency 1]");
  if (!process.env.OPENAI_COMPATIBLE_API_KEY) throw new Error("Set OPENAI_COMPATIBLE_API_KEY (and OPENAI_COMPATIBLE_BASE_URL) first.");
  const timeoutMs = positiveNumber(values["timeout-min"], "--timeout-min") * 60_000;
  const concurrency = Math.floor(positiveNumber(values.concurrency, "--concurrency"));
  const dbPath = path.resolve(values.db);
  if (!fs.existsSync(dbPath)) throw new Error(`Catalog DB not found: ${dbPath}`);

  const allCases = JSON.parse(fs.readFileSync(values.cases, "utf8")) as EvalCase[];
  const only = values.only?.split(",").map((id) => id.trim()).filter(Boolean);
  const unknown = only?.filter((id) => !allCases.some((c) => c.id === id)) ?? [];
  if (unknown.length > 0) throw new Error(`Unknown case id(s): ${unknown.join(", ")}`);
  const cases = only ? allCases.filter((c) => only.includes(c.id)) : allCases;

  const outDir = path.resolve(values.out ?? path.join("logs", "evals", `${new Date().toISOString().replace(/[:.]/g, "-")}-${model.replace(/[^\w.-]+/g, "_")}`));
  fs.mkdirSync(outDir, { recursive: true });
  const resultsPath = path.join(outDir, "results.json");
  const saved: CaseResult[] = fs.existsSync(resultsPath) ? (JSON.parse(fs.readFileSync(resultsPath, "utf8")) as { cases: CaseResult[] }).cases : [];

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const byId = db.prepare<[string], { id: string; category: string; name: string; in_stock: number }>("SELECT id, category, name, in_stock FROM products WHERE id = ?");
  const lookup: CatalogLookup = (id) => {
    const row = byId.get(id);
    return row ? ({ ...row, in_stock: row.in_stock === 1 } satisfies CatalogRow) : undefined;
  };
  const catalogDate = (db.prepare("SELECT MAX(last_scraped) AS d FROM products").get() as { d: string | null }).d ?? "unknown";
  const catalog = `${path.basename(dbPath)} (newest listing ${catalogDate.slice(0, 10)})`;
  const caseById = new Map(allCases.map((c) => [c.id, c]));
  const results: CaseResult[] = saved.map((r) => {
    const evalCase = caseById.get(r.id);
    return evalCase ? { ...scoreCase(evalCase, r.turn, lookup, r.wallMs, r.timedOut), turn: r.turn, timedOut: r.timedOut, trace: r.trace } : r;
  });

  // Every role gets the requested endpoint, so CHAT_LLM_CHAIN or
  // SUBAGENT_LLM_CHAIN in the environment can't swap the model under test.
  const endpoint = { provider: "openai-compatible" as const, model, baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL, keySource: "env" as const };
  // The app learns a model's context size at setup; without it the chat
  // engine assumes 32,768 tokens and summarises mid-turn from ~25K.
  const contextLimit = values["context-limit"] ? positiveNumber(values["context-limit"], "--context-limit") : await discoveredContextLimit(endpoint);
  console.log(`Context limit: ${contextLimit ?? "unknown (engine falls back to 32768)"}`);
  const chain = [{ ...endpoint, ...(contextLimit ? { contextLimit } : {}) }];

  const config = resolveConfig({
    llmChain: chain,
    chatLlmChain: chain,
    subagentLlmChain: chain,
    dbPath,
    countryCode: "IN",
    currency: "INR",
    searchProvider: "none"
  });

  const save = () => {
    const order = (id: string) => (caseById.has(id) ? allCases.findIndex((c) => c.id === id) : allCases.length);
    const ordered = [...results].sort((a, b) => order(a.id) - order(b.id));
    fs.writeFileSync(resultsPath, JSON.stringify({ model, catalog, cases: ordered }, null, 2));
    // Only re-scored results are published: one whose case left cases.json keeps its old wording.
    const published = ordered.filter((r) => caseById.has(r.id));
    fs.writeFileSync(path.join(outDir, "scorecard.md"), formatScorecard(published, { model, catalog, date: new Date().toISOString().slice(0, 10) }));
  };

  const pending = cases.filter((c) => !results.some((r) => r.id === c.id));
  if (pending.length < cases.length) console.log(`Skipping ${cases.length - pending.length} case(s) already scored in ${resultsPath}`);
  const worker = async () => {
    for (let evalCase = pending.shift(); evalCase; evalCase = pending.shift()) {
      let started = Date.now();
      let { turn, timedOut, trace } = await runCase(config, evalCase, timeoutMs);
      // A shared hosted model often answers 429 for a while: a case that died on
      // a provider error re-runs from scratch after a cool-down.
      for (let attempt = 1; attempt <= retries && !timedOut && turn.streamError && turn.builds.length === 0; attempt++) {
        console.log(`${evalCase.id}: provider error after ${turn.steps} steps (${turn.streamError?.slice(0, 160)}), retry ${attempt}/${retries} in ${retryWaitS}s`);
        await new Promise((resolve) => setTimeout(resolve, retryWaitS * 1000));
        started = Date.now();
        ({ turn, timedOut, trace } = await runCase(config, evalCase, timeoutMs));
      }
      const score = scoreCase(evalCase, turn, lookup, Date.now() - started, timedOut);
      results.push({ ...score, turn, timedOut, trace });
      save();
      const failures = [...score.turnFailures, ...(score.passed ? [] : score.builds[0]?.failures ?? [])];
      console.log(`${evalCase.id}: ${score.passed ? "PASS" : "FAIL"} in ${Math.round(score.wallMs / 1000)}s, ${score.steps} steps, ${score.builds.length} build(s)${failures.length ? ` — ${failures.join("; ")}` : ""}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  save();
  db.close();
  const scored = results.filter((r) => cases.some((c) => c.id === r.id));
  console.log(`\n${scored.filter((r) => r.passed).length}/${scored.length} cases pass. Scorecard: ${path.join(outDir, "scorecard.md")}`);
  return 0;
}

function positiveNumber(value: string | undefined, flag: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number, got "${value}"`);
  return n;
}

/** Runs one case through the chat engine, aborting after timeoutMs; never throws. */
async function runCase(config: ReturnType<typeof resolveConfig>, evalCase: EvalCase, timeoutMs: number): Promise<{ turn: AskTurn; timedOut: boolean; trace: TraceEvent[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs / 60_000} minutes`)), timeoutMs);
  const collector = createAskTurnCollector();
  const trace = createTraceRecorder();
  try {
    const result = await streamChat(config, [{ role: "user", content: evalCase.prompt }], undefined, controller.signal);
    for await (const part of result.fullStream) {
      collector.observe(part as AskStreamPart);
      trace.observe(part as { type: string });
    }
  } catch (error) {
    collector.observe({ type: "error", error });
  } finally {
    clearTimeout(timer);
  }
  const turn = collector.result();
  const timedOut = controller.signal.aborted;
  return { turn: timedOut && !turn.streamError ? { ...turn, streamError: String(controller.signal.reason) } : turn, timedOut, trace: trace.events };
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
);
