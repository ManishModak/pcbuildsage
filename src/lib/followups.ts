import { z } from "zod";
import { isToolPart } from "./message-parts";

export const followupsSchema = z.object({
  prompts: z.array(z.string().trim().min(1)).max(3).describe("Short user prompts for useful, unanswered next steps")
});

export function isFollowupsPart(part: unknown): boolean {
  return isToolPart(part) && (part.toolName === "suggest_followups" || part.type === "tool-suggest_followups");
}

/** Only the latest completed answer can offer actions; the last successful call wins. */
export function getFollowups(message: { role: string; parts?: readonly unknown[] } | undefined, status: string): string[] {
  if (status !== "ready" || message?.role !== "assistant") return [];
  const part = [...(message.parts ?? [])].reverse().find((part) => isFollowupsPart(part) && isToolPart(part) && part.state === "output-available");
  if (!isToolPart(part)) return [];
  const result = followupsSchema.safeParse(part.output);
  return result.success ? [...new Set(result.data.prompts)] : [];
}
