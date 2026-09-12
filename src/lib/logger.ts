import { promises as fs } from "node:fs";
import path from "node:path";
import { writeDbLog } from "./db";
import { isHostedDemo } from "./config/deployment";

export type ChatLogEntry = {
  timestamp?: string;
  session_id?: string;
  role?: "system" | "user" | "assistant" | "tool";
  content?: string;
  reasoning?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  modelId?: string;
  provider?: string;
};

export async function appendChatLog(entry: ChatLogEntry, logPath = path.join(process.cwd(), "logs", "chat.jsonl")): Promise<void> {
  // In hosted-demo mode, chat sessions and BYOK keys are ephemeral in-browser only.
  // We must not write chat logs to container disk.
  if (isHostedDemo()) {
    return;
  }

  const safe: ChatLogEntry = {
    timestamp: entry.timestamp ?? new Date().toISOString(),
    session_id: entry.session_id,
    role: entry.role,
    content: entry.content,
    reasoning: entry.reasoning,
    toolName: entry.toolName,
    toolArgs: entry.toolArgs,
    toolResult: entry.toolResult,
    modelId: entry.modelId,
    provider: entry.provider
  };

  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, `${JSON.stringify(safe)}\n`, "utf8");
  } catch (err) {
    // Ignore filesystem write failures to prevent interrupting user chat sessions
    console.warn("Failed to append chat log to file:", err instanceof Error ? err.message : String(err));
  }

  // Sync log entry to rotating SQLite logs table
  try {
    const level = entry.role === "tool" || entry.role === "system" ? "DEBUG" : "INFO";
    const component = entry.role === "tool" ? "tool" : "chat";
    const message = entry.role === "tool"
      ? `Tool Call: ${entry.toolName}`
      : `${entry.role?.toUpperCase() || "CHAT"} message`;
    writeDbLog(undefined, level, component, message, safe as Record<string, unknown>);
  } catch {
    // Ignore database write failures to prevent interrupting user chat sessions
  }
}
