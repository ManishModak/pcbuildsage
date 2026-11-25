import { describe, expect, it } from "vitest";
import { followupsSchema, getFollowups } from "../followups";

const suggestion = (prompts: string[], state = "output-available") => ({
  type: "tool-suggest_followups", state, output: { prompts }
});

describe("follow-up suggestions", () => {
  it("accepts zero to three short nonblank prompts", () => {
    expect(followupsSchema.parse({ prompts: [] })).toEqual({ prompts: [] });
    expect(followupsSchema.parse({ prompts: ["  Make it quieter  "] }).prompts).toEqual(["Make it quieter"]);
    for (const prompts of [[" "], ["a", "b", "c", "d"]]) {
      expect(followupsSchema.safeParse({ prompts }).success).toBe(false);
    }
  });

  it("only exposes completed tool output on a ready assistant answer", () => {
    const message = { role: "assistant", parts: [suggestion(["Make it quieter"])] };
    expect(getFollowups(message, "ready")).toEqual(["Make it quieter"]);
    for (const status of ["submitted", "streaming", "error"]) expect(getFollowups(message, status)).toEqual([]);
    expect(getFollowups({ ...message, role: "user" }, "ready")).toEqual([]);
    expect(getFollowups({ role: "assistant", parts: [suggestion(["Pending"], "input-available")] }, "ready")).toEqual([]);
    expect(getFollowups({ role: "assistant", parts: [{ ...suggestion([]), output: { prompts: [42] } }] }, "ready")).toEqual([]);
  });

  it("uses the latest result, deduplicates prompts, and permits clearing suggestions", () => {
    const parts = [suggestion(["Old"]), suggestion(["New", "New"])];
    expect(getFollowups({ role: "assistant", parts }, "ready")).toEqual(["New"]);
    expect(getFollowups({ role: "assistant", parts: [...parts, suggestion([])] }, "ready")).toEqual([]);
  });

  it("lets a later successful present_build without followups clear chips from an earlier presentation", () => {
    const firstPresent = {
      type: "tool-present_build",
      state: "output-available",
      output: { presented: true, followups: ["Upgrade this CPU"] }
    };
    const revisedPresent = {
      type: "tool-present_build",
      state: "output-available",
      output: { presented: true }
    };
    const refusedPresent = {
      type: "tool-present_build",
      state: "output-available",
      output: { presented: false, error: "not validated" }
    };
    expect(getFollowups({ role: "assistant", parts: [firstPresent, revisedPresent] }, "ready")).toEqual([]);
    // A refused presentation does not wipe out the earlier valid presentation's chips.
    expect(getFollowups({ role: "assistant", parts: [firstPresent, refusedPresent] }, "ready")).toEqual(["Upgrade this CPU"]);
  });
});
