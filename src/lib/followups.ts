import { z } from "zod";
import { isToolPart } from "./message-parts";

export const followupsSchema = z.object({
  prompts: z.array(z.string().trim().min(1)).max(3).describe("Short user prompts for useful, unanswered next steps")
});

const presentBuildFollowupsSchema = z.object({
  presented: z.literal(true),
  followups: z.array(z.string().trim().min(1)).min(1)
});

export function isFollowupsPart(part: unknown): boolean {
  return isToolPart(part) && (part.toolName === "suggest_followups" || part.type === "tool-suggest_followups");
}

function isPresentBuildPart(part: unknown): boolean {
  return isToolPart(part) && (part.toolName === "present_build" || part.type === "tool-present_build");
}

/** Only the latest completed answer can offer actions; the last successful call wins. */
export function getFollowups(message: { role: string; parts?: readonly unknown[] } | undefined, status: string): string[] {
  if (status !== "ready" || message?.role !== "assistant") return [];
  for (const part of [...(message.parts ?? [])].reverse()) {
    if (!isToolPart(part) || part.state !== "output-available") continue;
    if (isFollowupsPart(part)) {
      const result = followupsSchema.safeParse(part.output);
      if (result.success) return [...new Set(result.data.prompts)].slice(0, 3);
    } else if (isPresentBuildPart(part)) {
      const result = presentBuildFollowupsSchema.safeParse(part.output);
      if (result.success) return [...new Set(result.data.followups)].slice(0, 3);
    }
  }
  return [];
}
