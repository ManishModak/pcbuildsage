import { promises as fs } from "node:fs";
import path from "node:path";
import { writeDbLog } from "./db";

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
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify(safe)}\n`, "utf8");

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
