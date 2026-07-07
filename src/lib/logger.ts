import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type ChatLogEntry = {
  timestamp?: string;
  role?: "system" | "user" | "assistant" | "tool";
  content?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  modelId?: string;
  provider?: string;
};

export function appendChatLog(entry: ChatLogEntry, logPath = path.join(process.cwd(), "logs", "chat.jsonl")): void {
  const safe: ChatLogEntry = {
    timestamp: entry.timestamp ?? new Date().toISOString(),
    role: entry.role,
    content: entry.content,
    toolName: entry.toolName,
    toolArgs: entry.toolArgs,
    toolResult: entry.toolResult,
    modelId: entry.modelId,
    provider: entry.provider
  };
  mkdirSync(path.dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(safe)}\n`, "utf8");
}
