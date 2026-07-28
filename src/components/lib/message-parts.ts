import type { ToolPart } from "../chat/tool-chip";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ReasoningPart {
  type: "reasoning";
  text: string;
}

export function isTextPart(part: unknown): part is TextPart {
  if (typeof part !== "object" || part === null) return false;
  const p = part as Record<string, unknown>;
  return p.type === "text" && typeof p.text === "string";
}

export function isReasoningPart(part: unknown): part is ReasoningPart {
  if (typeof part !== "object" || part === null) return false;
  const p = part as Record<string, unknown>;
  return p.type === "reasoning" && typeof p.text === "string";
}

export function isToolPart(part: unknown): part is ToolPart {
  if (typeof part !== "object" || part === null) return false;
  const p = part as Record<string, unknown>;
  return typeof p.type === "string" && p.type.startsWith("tool-");
}
