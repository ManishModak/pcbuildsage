import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ConfigInput } from "@/types";

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
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);

  const temporaryPath = path.join(directory, `.${CLI_CONFIG_FILE}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
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
  for (const part of parts) {
    if (part === "__proto__" || part === "prototype" || part === "constructor") {
      throw new Error(`Invalid property key: ${part}`);
    }
  }
  let cursor: Record<string, unknown> = next as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const value = cursor[part];
    if (typeof value !== "object" || value === null || Array.isArray(value)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  const lastPart = parts.at(-1) ?? normalized;
  if (lastPart === "__proto__" || lastPart === "prototype" || lastPart === "constructor") {
    throw new Error(`Invalid property key: ${lastPart}`);
  }
  cursor[lastPart] = coerceValue(rawValue);
  return next;
}

export function isSensitiveConfigKey(key: string): boolean {
  return /(^|\.)(apiKey|key|token|secret|password)$/i.test(key) || /api[-_]?key/i.test(key);
}

function aliasKey(key: string): string {
  const parts = key.split(".");
  for (const part of parts) {
    if (part === "__proto__" || part === "prototype" || part === "constructor") {
      throw new Error(`Invalid property key: ${part}`);
    }
  }
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
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return value;
    }
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
