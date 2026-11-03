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
 *          [--timeout-min 10] [--concurrency 1]
 *
 * The model is reached as an OpenAI-compatible endpoint: set
 * OPENAI_COMPATIBLE_BASE_URL and OPENAI_COMPATIBLE_API_KEY in the environment.
 * Each case is aborted after --timeout-min; --concurrency runs that many cases
 * at once (each turn sends about one request per step, so mind the provider's
 * rate limit). Re-running with the same --out skips cases already in its
 * results.json, so an interrupted run resumes; saved turns are re-scored with
 * the current scorer, and results outside --only are kept.
 */

import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { resolveConfig } from "../src/lib/config";
import { streamChat } from "../src/lib/llm/chat-engine";
import { createAskTurnCollector, type AskStreamPart, type AskTurn } from "../src/cli/ask-turn";
import { formatScorecard, scoreCase, type CaseScore, type CatalogLookup, type CatalogRow, type EvalCase } from "./eval-recommendations-score";

type CaseResult = CaseScore & { turn: AskTurn; timedOut: boolean };

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      model: { type: "string" },
      db: { type: "string" },
      cases: { type: "string", default: "evals/recommendations/cases.json" },
      only: { type: "string" },
      out: { type: "string" },
      "timeout-min": { type: "string", default: "10" },
      concurrency: { type: "string", default: "1" }
    }
  });
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
    return evalCase ? { ...scoreCase(evalCase, r.turn, lookup, r.wallMs, r.timedOut), turn: r.turn, timedOut: r.timedOut } : r;
  });

  // Every role gets the requested endpoint, so CHAT_LLM_CHAIN or
  // SUBAGENT_LLM_CHAIN in the environment can't swap the model under test.
  const chain = [{ provider: "openai-compatible" as const, model, baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL, keySource: "env" as const }];

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
      const started = Date.now();
      const { turn, timedOut } = await runCase(config, evalCase, timeoutMs);
      const score = scoreCase(evalCase, turn, lookup, Date.now() - started, timedOut);
      results.push({ ...score, turn, timedOut });
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
async function runCase(config: ReturnType<typeof resolveConfig>, evalCase: EvalCase, timeoutMs: number): Promise<{ turn: AskTurn; timedOut: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs / 60_000} minutes`)), timeoutMs);
  const collector = createAskTurnCollector();
  try {
    const result = await streamChat(config, [{ role: "user", content: evalCase.prompt }], undefined, controller.signal);
    for await (const part of result.fullStream) collector.observe(part as AskStreamPart);
  } catch (error) {
    collector.observe({ type: "error", error });
  } finally {
    clearTimeout(timer);
  }
  const turn = collector.result();
  const timedOut = controller.signal.aborted;
  return { turn: timedOut && !turn.streamError ? { ...turn, streamError: String(controller.signal.reason) } : turn, timedOut };
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
);
