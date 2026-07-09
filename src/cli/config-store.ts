import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ConfigInput } from "../lib/config-types";

export const CLI_CONFIG_DIR = ".pcbuildsage";
export const CLI_CONFIG_FILE = "config.json";

export type CliConfig = ConfigInput & {
  savedKeys?: Record<string, string>;
};

export function configPath(cwd = process.cwd()): string {
  return path.join(cwd, CLI_CONFIG_DIR, CLI_CONFIG_FILE);
}

export function hasCliConfig(cwd = process.cwd()): boolean {
  return existsSync(configPath(cwd));
}

export function readCliConfig(cwd = process.cwd()): CliConfig {
  const filePath = configPath(cwd);
  if (!existsSync(filePath)) return {};
  return JSON.parse(readFileSync(filePath, "utf8")) as CliConfig;
}

export function writeCliConfig(config: CliConfig, cwd = process.cwd()): void {
  const filePath = configPath(cwd);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function getConfigValue(config: CliConfig, key: string): unknown {
  const normalized = aliasKey(key);
  return normalized.split(".").reduce<unknown>((current, part) => {
    if (typeof current !== "object" || current === null) return undefined;
    return (current as Record<string, unknown>)[part];
  }, config);
}

export function setConfigValue(config: CliConfig, key: string, rawValue: string): CliConfig {
  const normalized = aliasKey(key);
  const next = structuredClone(config) as CliConfig;
  const parts = normalized.split(".");
  let cursor: Record<string, unknown> = next as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const value = cursor[part];
    if (typeof value !== "object" || value === null || Array.isArray(value)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1) ?? normalized] = coerceValue(rawValue);
  return next;
}

export function isSensitiveConfigKey(key: string): boolean {
  return /(^|\.)(apiKey|key|token|secret|password)$/i.test(key) || /api[-_]?key/i.test(key);
}

function aliasKey(key: string): string {
  if (key === "audit") return "tier2Enabled";
  if (key === "profile") return "activeProfile";
  if (key === "provider") return "llmChain";
  return key;
}

function coerceValue(value: string): unknown {
  const trimmed = value.trim();
  if (["true", "false"].includes(trimmed.toLowerCase())) return trimmed.toLowerCase() === "true";
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    return JSON.parse(trimmed) as unknown;
  }
  return value;
}

export function stripUnsavedKeys(config: CliConfig): CliConfig {
  const copy = structuredClone(config) as CliConfig;
  for (const key of ["llmChain", "chatLlmChain", "subagentLlmChain", "scraperLlmChain"] as const) {
    const value = copy[key];
    if (Array.isArray(value)) {
      copy[key] = value.map((entry) => entry.apiKey ? { ...entry, apiKey: undefined, keySource: "env" } : entry);
    }
  }
  return copy;
}

export function redactConfig(config: CliConfig): CliConfig {
  const copy = structuredClone(config) as CliConfig;
  for (const key of ["llmChain", "chatLlmChain", "subagentLlmChain", "scraperLlmChain"] as const) {
    const value = copy[key];
    if (Array.isArray(value)) copy[key] = value.map((entry) => entry.apiKey ? { ...entry, apiKey: "[redacted]" } : entry);
  }
  if (copy.savedKeys) copy.savedKeys = Object.fromEntries(Object.keys(copy.savedKeys).map((key) => [key, "[redacted]"]));
  return copy;
}

