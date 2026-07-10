import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { confirm } from "@clack/prompts";
import { resolveConfig } from "../lib/config";
import type { ConfigInput, LLMChainEntry, LLMProvider, SearchProvider } from "../lib/config-types";
import { streamChat, type ChatMessage } from "../lib/chat-engine";
import { discoverModels } from "../lib/model-discovery";
import { loadEndpointPresets } from "../lib/endpoints";
import { validateBuild, type BuildParts } from "../lib/rules-engine";
import { exportResearch } from "../lib/export-research";
import { appendChatLog } from "../lib/logger";
import { booleanFlag, csvFlag, numberFlag, parseArgv, stringFlag, type ParsedArgs } from "./arg-parser";
import { findCommand, helpText } from "./commands";
import { getConfigValue, hasCliConfig, isSensitiveConfigKey, readCliConfig, setConfigValue, writeCliConfig, redactConfig, type CliConfig } from "./config-store";
import { runScraper, runTestProfile, type ScrapeRunConfig } from "./scrape";
import { STATUS_GLYPHS, banner, createPalette, listThemes, type Palette } from "./theme";
import { onboarding, ensureNotCanceled } from "./onboarding";
import { downloadSeed } from "../lib/seed-download-helper";

type Runtime = {
  saved: CliConfig;
  palette: Palette;
  version: string;
};

const PROVIDERS: LLMProvider[] = ["gemini", "ollama", "openrouter", "openai-compatible"];
const SEARCH_PROVIDERS: SearchProvider[] = ["exa", "tavily", "brave", "searxng", "duckduckgo", "gemini-native", "none"];

async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgv(argv);
  const saved = readCliConfig();
  const version = readPackageVersion();
  const palette = createPalette(saved.theme);
  const runtime: Runtime = { saved, palette, version };

  try {
    if (!parsed.command) {
      await interactive(runtime);
      return 0;
    }
    return await runSubcommand(parsed, runtime);
  } catch (error) {
    if (booleanFlag(parsed.flags, "json")) {
      console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    } else {
      console.error(palette.blocking(`${STATUS_GLYPHS.blocking} ${error instanceof Error ? error.message : String(error)}`));
    }
    return 1;
  }
}

async function interactive(runtime: Runtime): Promise<void> {
  if (!output.isTTY) throw new Error("Interactive mode requires a TTY. Use a subcommand for scripts.");
  console.log(banner(runtime.version, runtime.palette));
  let sessionConfig = runtime.saved;
  if (!hasCliConfig()) {
    sessionConfig = await onboarding(runtime);
  }
  await repl(sessionConfig, runtime);
}

async function repl(sessionConfig: CliConfig, runtime: Runtime): Promise<void> {
  const rl = createInterface({ input, output });
  const messages: ChatMessage[] = [];
  console.log(runtime.palette.muted("Type /help for commands, /exit to quit."));
  try {
    while (true) {
      const line = (await rl.question(runtime.palette.accent("pcbuildsage> "))).trim();
      if (!line) continue;
      try {
        if (line.startsWith("/")) {
          const shouldExit = await runSlash(line, sessionConfig, runtime);
          if (shouldExit) break;
          sessionConfig = readCliConfig();
          continue;
        }
        messages.push({ role: "user", content: line });
        const assistant = await streamAssistant(sessionConfig, messages, runtime.palette);
        messages.push({ role: "assistant", content: assistant });
      } catch (error) {
        // A failed command or chat turn must not end the session.
        console.error(runtime.palette.blocking(`${STATUS_GLYPHS.blocking} ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  } finally {
    rl.close();
  }
}

async function runSlash(line: string, config: CliConfig, runtime: Runtime): Promise<boolean> {
  const [slash, ...parts] = line.split(/\s+/);
  const command = findCommand(slash);
  if (!command) {
    console.log(`Unknown command: ${slash}`);
    return false;
  }
  if (command.name === "exit") return true;
  if (command.name === "help") {
    console.log(helpText("interactive"));
    return false;
  }
  const parsed: ParsedArgs = parseArgv([command.subcommand, ...parts]);
  await runSubcommand(parsed, { ...runtime, saved: config });
  return false;
}

async function runSubcommand(parsed: ParsedArgs, runtime: Runtime): Promise<number> {
  switch (parsed.command) {
    case "ask":
      return askCommand(parsed, runtime);
    case "scrape":
      return scrapeCommand(parsed, runtime);
    case "test-profile":
      return testProfileCommand(parsed);
    case "validate":
      return validateCommand(parsed);
    case "models":
      return modelsCommand(parsed);
    case "config":
      return configCommand(parsed);
    case "export-research":
      return exportResearchCommand(parsed, runtime);
    case "seed":
      return seedCommand(parsed, runtime);
    case "provider":
      return simpleSetCommand("llmChain", parsed, runtime, "provider chain");
    case "persona":
      return simpleSetCommand("persona", parsed, runtime, "persona");
    case "personality":
      return simpleSetCommand("personality", parsed, runtime, "personality");
    case "audit":
      return auditCommand(parsed);
    case "search":
      return searchCommand(parsed, runtime);
    case "theme":
      return simpleSetCommand("theme", parsed, runtime, "theme");
    case "help":
      console.log(helpText("subcommand"));
      return 0;
    default:
      throw new Error(`Unknown command "${parsed.command}". Run pcbuildsage help.`);
  }
}

async function askCommand(parsed: ParsedArgs, runtime: Runtime): Promise<number> {
  const query = parsed.positionals.join(" ").trim();
  if (!query) throw new Error('Usage: pcbuildsage ask "<query>" [--persona id] [--json]');
  const flags: ConfigInput = {};
  const persona = stringFlag(parsed.flags, "persona");
  if (persona) flags.persona = persona;
  const config = { ...runtime.saved, ...flags };
  const messages: ChatMessage[] = [{ role: "user", content: query }];
  if (booleanFlag(parsed.flags, "json")) {
    const content = await collectAssistant(config, messages);
    console.log(JSON.stringify({ content }));
  } else {
    await streamAssistant(config, messages, runtime.palette);
    console.log();
  }
  return 0;
}

async function scrapeCommand(parsed: ParsedArgs, runtime: Runtime): Promise<number> {
  const profile = stringFlag(parsed.flags, "profile") ?? runtime.saved.activeProfile;
  if (!profile) throw new Error("scrape requires --profile or saved activeProfile.");
  const config: ScrapeRunConfig = {
    profile,
    sites: csvFlag(parsed.flags, "sites"),
    categories: csvFlag(parsed.flags, "categories"),
    quick: booleanFlag(parsed.flags, "quick"),
    maxPages: numberFlag(parsed.flags, "maxPages"),
    skipFresh: numberFlag(parsed.flags, "skipFresh"),
    noLlmFallback: parsed.flags.llmFallback === false || booleanFlag(parsed.flags, "noLlmFallback"),
    maxLlmCalls: numberFlag(parsed.flags, "maxLlmCalls"),
    concurrency: numberFlag(parsed.flags, "concurrency"),
    delayMs: numberFlag(parsed.flags, "delayMs"),
    headed: booleanFlag(parsed.flags, "headed"),
    db: stringFlag(parsed.flags, "db")
  };
  return runScraper(config, runtime.palette, { json: booleanFlag(parsed.flags, "json") });
}

async function testProfileCommand(parsed: ParsedArgs): Promise<number> {
  const profile = parsed.positionals[0];
  if (!profile) throw new Error("test-profile requires a profile file or id.");
  return runTestProfile({
    profile,
    site: stringFlag(parsed.flags, "site"),
    categories: csvFlag(parsed.flags, "categories"),
    headed: booleanFlag(parsed.flags, "headed"),
    delayMs: numberFlag(parsed.flags, "delayMs")
  });
}

async function validateCommand(parsed: ParsedArgs): Promise<number> {
  const partsPath = stringFlag(parsed.flags, "parts") ?? parsed.positionals[0];
  const raw = partsPath && partsPath !== "-" ? readFileSync(partsPath, "utf8") : await readStdin();
  if (!raw.trim()) throw new Error("validate requires --parts <file> or JSON on stdin.");
  const parsedJson = JSON.parse(raw) as unknown;
  const parts = isPartsEnvelope(parsedJson) ? parsedJson.parts : parsedJson as BuildParts;
  const result = validateBuild(parts);
  if (booleanFlag(parsed.flags, "json")) {
    console.log(JSON.stringify(result));
  } else {
    console.log(result.valid ? `${STATUS_GLYPHS.ok} valid` : `${STATUS_GLYPHS.blocking} invalid`);
    for (const issue of result.issues) console.log(`${issue.severity}: ${issue.rule} - ${issue.detail}`);
  }
  return result.valid ? 0 : 2;
}

async function modelsCommand(parsed: ParsedArgs): Promise<number> {
  const provider = providerFromName(stringFlag(parsed.flags, "provider") ?? parsed.positionals[0]);
  const baseUrl = stringFlag(parsed.flags, "baseUrl");
  const model = stringFlag(parsed.flags, "model") ?? "__model_discovery__";
  const entry: LLMChainEntry = { provider, baseUrl, model, keySource: "env" };
  const models = await discoverModels(entry);
  if (booleanFlag(parsed.flags, "json")) console.log(JSON.stringify({ models }));
  else for (const item of models) console.log(item.name ? `${item.id}\t${item.name}` : item.id);
  return 0;
}

async function configCommand(parsed: ParsedArgs): Promise<number> {
  const action = parsed.positionals[0];
  const key = parsed.positionals[1];
  const value = parsed.positionals.slice(2).join(" ");
  const current = readCliConfig();
  if (action === "get") {
    if (!key) console.log(JSON.stringify(redactConfig(current), null, 2));
    else {
      const result = getConfigValue(current, key);
      console.log(isSensitiveConfigKey(key) && result !== undefined ? "[redacted]" : JSON.stringify(result));
    }
    return 0;
  }
  if (action === "set") {
    if (!key || !value) throw new Error("Usage: pcbuildsage config set <key> <value>");
    if (isSensitiveConfigKey(key)) {
      if (!output.isTTY) throw new Error("Saving credentials requires interactive confirmation.");
      const ok = await confirm({ message: `Save sensitive value for ${key} to disk?`, initialValue: false });
      ensureNotCanceled(ok);
      if (!ok) throw new Error("Credential was not saved.");
    }
    writeCliConfig(setConfigValue(current, key, value));
    console.log(isSensitiveConfigKey(key) ? `${key}=[redacted]` : `${key}=${value}`);
    return 0;
  }
  throw new Error("Usage: pcbuildsage config get|set <key> [value]");
}

async function exportResearchCommand(parsed: ParsedArgs, runtime: Runtime): Promise<number> {
  const written = exportResearch({ dbPath: stringFlag(parsed.flags, "db") ?? runtime.saved.dbPath, outputDir: stringFlag(parsed.flags, "outputDir") });
  if (booleanFlag(parsed.flags, "json")) console.log(JSON.stringify({ written }));
  else console.log(written.length ? written.join("\n") : "No registry research entries to export.");
  return 0;
}

async function seedCommand(parsed: ParsedArgs, runtime: Runtime): Promise<number> {
  const country = (stringFlag(parsed.flags, "country") ?? parsed.positionals[0])?.toUpperCase();
  if (!country || !/^[A-Z]{2}$/.test(country)) throw new Error("seed requires --country <ISO-2>.");
  const dbPath = stringFlag(parsed.flags, "db") ?? runtime.saved.dbPath ?? "data/products.db";
  const jsonMode = booleanFlag(parsed.flags, "json");
  if (!jsonMode) console.log(`Downloading community seed dataset for ${country}...`);
  await downloadSeed(country, {
    dbPath,
    onProgress(percent, message) {
      if (!jsonMode) process.stdout.write(`\rProgress: [${percent}%] ${message}`);
    }
  });
  if (jsonMode) console.log(JSON.stringify({ ok: true, country, dbPath }));
  else console.log(`\nSeed database for ${country} downloaded successfully.`);
  return 0;
}

async function simpleSetCommand(key: string, parsed: ParsedArgs, runtime: Runtime, label: string): Promise<number> {
  const value = parsed.positionals.join(" ").trim();
  if (!value) {
    console.log(`${label}: ${JSON.stringify(getConfigValue(runtime.saved, key))}`);
    if (key === "theme") console.log(`available: ${listThemes().join(", ")}`);
    return 0;
  }
  const next = setConfigValue(readCliConfig(), key, value);
  writeCliConfig(next);
  console.log(`${label}=${value}`);
  return 0;
}

async function auditCommand(parsed: ParsedArgs): Promise<number> {
  const value = parsed.positionals[0];
  if (!value || !["on", "off"].includes(value)) throw new Error("Usage: pcbuildsage audit on|off");
  writeCliConfig(setConfigValue(readCliConfig(), "tier2Enabled", value === "on" ? "true" : "false"));
  console.log(`audit=${value}`);
  return 0;
}

async function searchCommand(parsed: ParsedArgs, runtime: Runtime): Promise<number> {
  const value = parsed.positionals[0];
  if (!value) {
    console.log(`search=${runtime.saved.searchProvider ?? "none"}`);
    console.log(`available: ${SEARCH_PROVIDERS.join(", ")}`);
    return 0;
  }
  const provider = value === "off" ? "none" : value;
  if (!SEARCH_PROVIDERS.includes(provider as SearchProvider)) throw new Error(`Unknown search provider: ${value}`);
  writeCliConfig(setConfigValue(readCliConfig(), "searchProvider", provider));
  console.log(`search=${provider}`);
  return 0;
}

async function streamAssistant(configInput: CliConfig, messages: ChatMessage[], palette: Palette): Promise<string> {
  const config = resolveConfig(configInput);
  const result = await streamChat(config, messages);
  if (result.fallbackIndex > 0) {
    const message = `Failover: using ${result.provider}:${result.model}`;
    appendChatLog({ role: "system", content: message, provider: result.provider, modelId: result.model });
    console.log(palette.warn(`${STATUS_GLYPHS.warn} ${message}`));
  }
  let content = "";
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      content += part.text;
      process.stdout.write(part.text);
    } else if (part.type === "tool-result") {
      console.log(`\n${formatToolResult(part.toolName, part.output, palette)}`);
    } else if (part.type === "tool-error") {
      console.log(`\n${palette.blocking(`⚒ ${part.toolName} → ${part.error instanceof Error ? part.error.message : String(part.error)}`)}`);
    }
  }
  console.log();
  return content;
}

async function collectAssistant(configInput: CliConfig, messages: ChatMessage[]): Promise<string> {
  const config = resolveConfig(configInput);
  const result = await streamChat(config, messages);
  let content = "";
  for await (const part of result.textStream) content += part;
  return content;
}

function formatToolResult(toolName: string, outputValue: unknown, palette: Palette): string {
  if (toolName === "validate_build" && typeof outputValue === "object" && outputValue !== null) {
    const issues = Array.isArray((outputValue as { issues?: unknown[] }).issues) ? (outputValue as { issues: unknown[] }).issues : [];
    const blocking = issues.filter((issue) => typeof issue === "object" && issue !== null && (issue as { severity?: string }).severity === "blocking").length;
    return palette.muted(`⚒ validate_build → ${blocking} blocking issues`);
  }
  return palette.muted(`⚒ ${toolName} → done`);
}

function providerFromName(value: string | undefined): LLMProvider {
  if (!value) throw new Error("models requires --provider <name>.");
  if (PROVIDERS.includes(value as LLMProvider)) return value as LLMProvider;
  const preset = loadEndpointPresets().find((item) => item.name === value);
  if (preset) return "openai-compatible";
  throw new Error(`Unknown provider: ${value}`);
}

function isPartsEnvelope(value: unknown): value is { parts: BuildParts } {
  return typeof value === "object" && value !== null && "parts" in value;
}

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function readPackageVersion(): string {
  const data = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version?: string };
  return data.version ?? "0.0.0";
}

void main().then((code) => {
  process.exitCode = code;
});
