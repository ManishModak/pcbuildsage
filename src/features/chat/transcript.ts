import type { ChatUIMessage } from "./message";
import { isTextPart, isReasoningPart, isToolPart } from "@/lib/message-parts";
import { getErrorMessage, formatModelName } from "@/lib/format";
import type { ToolPart } from "./tool-chip";

export interface TranscriptOptions {
  id?: string;
  title?: string | null;
  messages: ChatUIMessage[];
  modelName?: string;
  error?: unknown;
  currency?: string;
  countryCode?: string;
}

function getToolName(part: ToolPart): string {
  if (part.toolName) return part.toolName;
  if (part.type.startsWith("tool-")) return part.type.slice("tool-".length);
  return part.type;
}

/**
 * Format a chat session into a clean, human- and LLM-readable Markdown document.
 * Includes user prompts, assistant reasoning, tool invocations with inputs & outputs,
 * and any runtime/provider errors encountered.
 */
export function formatMarkdownTranscript(options: TranscriptOptions): string {
  const { id, title, messages, modelName, error, currency, countryCode } = options;
  const lines: string[] = [];

  const displayTitle = title?.trim() || "Chat Transcript";
  lines.push(`# PCBuildSage Chat: ${displayTitle}`);
  lines.push("");
  lines.push(`- **Exported**: ${new Date().toISOString()}`);
  if (id) lines.push(`- **Session ID**: \`${id}\``);
  if (modelName) lines.push(`- **Model**: ${formatModelName(modelName)} (\`${modelName}\`)`);
  if (currency) lines.push(`- **Currency**: ${currency}`);
  if (countryCode) lines.push(`- **Market**: ${countryCode}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const message of messages) {
    const isUser = message.role === "user";
    const roleHeader = isUser
      ? "## 👤 User"
      : `## 🤖 Assistant${modelName ? ` (${formatModelName(modelName)})` : ""}`;
    lines.push(roleHeader);
    lines.push("");

    const rawContent = (message as unknown as { content?: unknown }).content;
    const parts = Array.isArray(message.parts) && message.parts.length > 0
      ? message.parts
      : typeof rawContent === "string"
        ? [{ type: "text" as const, text: rawContent }]
        : [];

    let hasRenderedText = false;

    for (const part of parts) {
      if (isReasoningPart(part)) {
        if (part.text && part.text.trim()) {
          lines.push("<details>");
          lines.push("<summary>Thinking Process</summary>");
          lines.push("");
          lines.push(part.text.trim());
          lines.push("");
          lines.push("</details>");
          lines.push("");
        }
      } else if (isToolPart(part)) {
        const toolPart = (part as unknown) as ToolPart;
        const name = getToolName(toolPart);
        const stateSuffix = toolPart.state ? ` [${toolPart.state}]` : "";
        lines.push(`> 🛠️ **Tool Call**: \`${name}\`${stateSuffix}`);

        if (toolPart.input !== undefined) {
          lines.push("> **Input**:");
          lines.push("> ```json");
          const formattedInput = JSON.stringify(toolPart.input, null, 2);
          for (const inputLine of formattedInput.split("\n")) {
            lines.push(`> ${inputLine}`);
          }
          lines.push("> ```");
        }

        if (toolPart.output !== undefined) {
          lines.push("> **Output**:");
          lines.push("> ```json");
          const formattedOutput = JSON.stringify(toolPart.output, null, 2);
          for (const outputLine of formattedOutput.split("\n")) {
            lines.push(`> ${outputLine}`);
          }
          lines.push("> ```");
        }

        if (toolPart.errorText) {
          lines.push(`> ⚠️ **Tool Error**: ${toolPart.errorText}`);
        }
        lines.push("");
      } else if (isTextPart(part)) {
        if (part.text && part.text.trim()) {
          lines.push(part.text.trim());
          lines.push("");
          hasRenderedText = true;
        }
      }
    }

    if (!hasRenderedText && typeof rawContent === "string" && rawContent.trim()) {
      lines.push(rawContent.trim());
      lines.push("");
    }
  }

  // 4. Runtime error (if chat failed or terminated with error)
  if (error) {
    const errorMsg = getErrorMessage(error);
    lines.push("---");
    lines.push("");
    lines.push(`> ⚠️ **Provider / Runtime Error**: ${errorMsg}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Format a chat session into a clean JSON string for developer inspection,
 * testing, and simulation replay.
 */
export function formatJsonTranscript(options: TranscriptOptions): string {
  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    session: {
      id: options.id ?? null,
      title: options.title ?? null,
      model: options.modelName ?? null,
      currency: options.currency ?? null,
      countryCode: options.countryCode ?? null
    },
    error: options.error ? getErrorMessage(options.error) : null,
    messages: options.messages.map((m, idx) => ({
      id: m.id || `msg-${idx}`,
      role: m.role,
      createdAt: m.createdAt ? new Date(m.createdAt).toISOString() : undefined,
      parts: m.parts,
      content: (m as unknown as { content?: unknown }).content
    }))
  };

  return JSON.stringify(payload, null, 2);
}

/**
 * Copy string to the clipboard with fallback for non-secure contexts or iframes.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to DOM fallback
    }
  }

  if (typeof document !== "undefined") {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      textarea.style.top = "-9999px";
      textarea.setAttribute("readonly", "");
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const successful = document.execCommand("copy");
      document.body.removeChild(textarea);
      if (successful) return true;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Trigger browser file download for a transcript.
 */
export function downloadTranscriptFile(
  filename: string,
  content: string,
  mimeType = "text/markdown;charset=utf-8"
): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
