import { existsSync } from "node:fs";
import path from "node:path";
import { cancel, confirm, intro, isCancel, log, outro, password, select, text } from "@clack/prompts";
import { generateTextWithFallback, probeToolCapability } from "../lib/llm-client";
import { discoverModels } from "../lib/model-discovery";
import type { LLMChainEntry, LLMProvider } from "../lib/config-types";
import { loadEndpointPresets } from "../lib/endpoints";
import { loadPersonalities } from "../lib/personalities";
import { estimateScrape } from "./scrape";
import { STATUS_GLYPHS, type Palette } from "./theme";
import { configPath, writeCliConfig, stripUnsavedKeys, type CliConfig } from "./config-store";

type Runtime = {
  saved: CliConfig;
  palette: Palette;
  version: string;
};

export async function onboarding(runtime: Runtime): Promise<CliConfig> {
  intro("PCBuildSage first run");
  const config: CliConfig = {
    personality: "helpful-consultant",
    theme: "sage-dark",
    tier2Enabled: true,
    countryCode: "IN",
    currency: "INR"
  };

  const dataSource = await select({
    message: "Choose a data source",
    options: [
      { value: "existing", label: "Use existing DB", hint: existsSync(path.join(process.cwd(), "data", "products.db")) ? "data/products.db found" : "create/open local DB" },
      { value: "scrape", label: "Scrape fresh data", hint: "configure profile and depth" }
    ],
    initialValue: existsSync(path.join(process.cwd(), "data", "products.db")) ? "existing" : "scrape"
  });
  ensureNotCanceled(dataSource);

  if (dataSource === "scrape") {
    const profile = await text({ message: "Profile", defaultValue: "india" });
    ensureNotCanceled(profile);
    config.activeProfile = profile;
    const estimate = estimateScrape({ profile, quick: true });
    log.info(`Quick scrape estimate: ${estimate.duration} (${estimate.jobs} jobs, ${estimate.pages} pages). Run /scrape when ready.`);
  }

  const { entry: chainEntry, persistKey } = await promptLlmEntry(runtime.palette);
  config.llmChain = [chainEntry];
  config.chatLlmChain = [chainEntry];

  const personality = await select({
    message: "Chat personality",
    options: loadPersonalities().map((item) => ({ value: item.id, label: item.name, hint: item.description })),
    initialValue: "helpful-consultant"
  });
  ensureNotCanceled(personality);
  config.personality = personality;

  writeCliConfig(persistKey ? config : stripUnsavedKeys(config));
  outro(`Saved ${configPath()}`);
  return config;
}

async function promptLlmEntry(palette: Palette): Promise<{ entry: LLMChainEntry; persistKey: boolean }> {
  const endpointPresets = loadEndpointPresets();
  const provider = await select({
    message: "Primary LLM provider",
    options: [
      { value: "gemini", label: "Gemini", hint: "GEMINI_API_KEY" },
      { value: "ollama", label: "Ollama", hint: "local OpenAI-compatible endpoint" },
      { value: "openrouter", label: "OpenRouter", hint: "OPENROUTER_API_KEY" },
      ...endpointPresets.map((preset) => ({ value: `preset:${preset.name}`, label: preset.name, hint: preset.launch_flags ?? preset.base_url })),
      { value: "openai-compatible", label: "Custom OpenAI-compatible", hint: "base URL required" }
    ],
    initialValue: "gemini"
  });
  ensureNotCanceled(provider);

  const preset = typeof provider === "string" && provider.startsWith("preset:")
    ? endpointPresets.find((item) => item.name === provider.slice("preset:".length))
    : undefined;
  const providerName: LLMProvider = preset ? "openai-compatible" : provider as LLMProvider;
  const baseUrl = providerName === "openai-compatible" || providerName === "ollama"
    ? await promptBaseUrl(providerName, preset?.base_url)
    : undefined;
  const keySource = preset?.requires_key === false || providerName === "ollama"
    ? "none"
    : await promptKeySource(providerName);
  const apiKey = keySource === "ui" ? await promptApiKey(providerName) : undefined;
  const discoveryEntry: LLMChainEntry = { provider: providerName, model: "__model_discovery__", baseUrl, apiKey, keySource };
  const model = await chooseModel(discoveryEntry);
  const entry: LLMChainEntry = { ...discoveryEntry, model };

  log.info("Testing one-token response...");
  await generateTextWithFallback({ chain: [entry], prompt: "Reply with ok." });
  log.info("Probing tool capability...");
  const toolProbe = await probeToolCapability(entry);
  if (!toolProbe.ok) {
    const flag = preset?.launch_flags ? ` Enable: ${preset.launch_flags}` : "";
    throw new Error(`Endpoint is reachable but not tool-capable.${flag} ${toolProbe.remedies?.join(" ") ?? ""}`.trim());
  }
  console.log(palette.ok(`${STATUS_GLYPHS.ok} ${providerName}:${model} is tool-capable`));

  let persistKey = false;
  if (apiKey) {
    const save = await confirm({ message: "Save this API key to .pcbuildsage/config.json?", initialValue: false });
    ensureNotCanceled(save);
    if (save) persistKey = true;
    else delete entry.apiKey;
  }
  return { entry, persistKey };
}

async function promptBaseUrl(provider: LLMProvider, defaultValue?: string): Promise<string> {
  const baseUrl = await text({
    message: "Base URL",
    defaultValue: defaultValue ?? (provider === "ollama" ? "http://localhost:11434" : "http://localhost:8000/v1")
  });
  ensureNotCanceled(baseUrl);
  return baseUrl;
}

async function promptKeySource(provider: LLMProvider): Promise<"env" | "ui"> {
  const envKey = provider === "gemini" ? "GEMINI_API_KEY" : provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_COMPATIBLE_API_KEY";
  const source = await select({
    message: "Credential source",
    options: [
      { value: "env", label: `Use ${envKey}`, hint: process.env[envKey] ? "detected" : "not detected" },
      { value: "ui", label: "Enter key now", hint: "saving requires confirmation" }
    ],
    initialValue: process.env[envKey] ? "env" : "ui"
  });
  ensureNotCanceled(source);
  return source as "env" | "ui";
}

async function promptApiKey(provider: LLMProvider): Promise<string> {
  const key = await password({ message: `${provider} API key`, validate: (value) => value.trim() ? undefined : "Key is required." });
  ensureNotCanceled(key);
  return key;
}

async function chooseModel(entry: LLMChainEntry): Promise<string> {
  try {
    const models = await discoverModels(entry);
    if (models.length) {
      const choice = await select({
        message: "Model",
        options: models.slice(0, 50).map((model) => ({ value: model.id, label: model.name ? `${model.name} (${model.id})` : model.id }))
      });
      ensureNotCanceled(choice);
      return choice;
    }
  } catch (error) {
    log.warn(`Model list unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const model = await text({ message: "Model id", validate: (value) => value.trim() ? undefined : "Model id is required." });
  ensureNotCanceled(model);
  return model;
}

export function ensureNotCanceled<T>(value: T | symbol): asserts value is T {
  if (isCancel(value)) {
    cancel("Canceled");
    process.exit(0);
  }
}
