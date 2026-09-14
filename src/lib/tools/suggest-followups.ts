import { tool } from "ai";
import { followupsSchema } from "../followups";

export function createSuggestFollowupsTool() {
  return tool({
    description: "Optionally offer up to 3 short follow-up prompts the user can click after your answer. Pass an empty list to clear suggestions.",
    inputSchema: followupsSchema,
    execute: async (input) => input
  });
}
