import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getFollowups } from "@/lib/followups";
import { MessageView, type ChatUIMessage } from "../message";
import { formatMarkdownTranscript } from "../transcript";

const message = {
  id: "answer", role: "assistant", parts: [
    { type: "tool-suggest_followups", toolCallId: "suggestions", state: "output-available", input: { prompts: ["Make it quieter"] }, output: { prompts: ["Make it quieter"] } },
    { type: "text", text: "Your completed answer." }
  ]
} as ChatUIMessage;

describe("follow-up actions", () => {
  it("hides the raw tool in chat while retaining it in transcripts", () => {
    const markup = renderToStaticMarkup(<MessageView message={message} />);
    expect(markup).not.toContain("suggest_followups");
    expect(markup).not.toContain("Make it quieter");
    expect(formatMarkdownTranscript({ messages: [message] })).toContain("suggest_followups");
  });

  it("places accessible prompt buttons below the answer", () => {
    const markup = renderToStaticMarkup(<MessageView message={message} followups={["Make it quieter"]} onFollowup={vi.fn()} />);
    expect(markup).toContain('aria-label="Suggested follow-ups"');
    expect(markup).toContain('type="button"');
    expect(markup).toContain("focus-visible:outline");
    expect(markup.indexOf("Make it quieter")).toBeGreaterThan(markup.indexOf("Your completed answer."));
  });

  it("reads followups from present_build when presented and respects suggest_followups precedence and clearing", () => {
    const presentOnly = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-present_build",
          toolCallId: "p1",
          state: "output-available",
          output: { presented: true, followups: ["Add a GPU", "Add a GPU", "Upgrade to 32GB RAM", "Extra 1", "Extra 2"] }
        },
        { type: "text", text: "Done." }
      ]
    };
    expect(getFollowups(presentOnly, "ready")).toEqual(["Add a GPU", "Upgrade to 32GB RAM", "Extra 1"]);
    expect(getFollowups(presentOnly, "streaming")).toEqual([]);

    const suggestOverrides = {
      id: "a2",
      role: "assistant",
      parts: [
        { type: "tool-present_build", toolCallId: "p1", state: "output-available", output: { presented: true, followups: ["From present"] } },
        { type: "tool-suggest_followups", toolCallId: "s1", state: "output-available", output: { prompts: ["From suggest"] } }
      ]
    };
    expect(getFollowups(suggestOverrides, "ready")).toEqual(["From suggest"]);

    const presentOverrides = {
      id: "a3",
      role: "assistant",
      parts: [
        { type: "tool-suggest_followups", toolCallId: "s1", state: "output-available", output: { prompts: ["Earlier suggest"] } },
        { type: "tool-present_build", toolCallId: "p1", state: "output-available", output: { presented: true, followups: ["Latest present"] } }
      ]
    };
    expect(getFollowups(presentOverrides, "ready")).toEqual(["Latest present"]);

    const clearedByEmptySuggest = {
      id: "a4",
      role: "assistant",
      parts: [
        { type: "tool-present_build", toolCallId: "p1", state: "output-available", output: { presented: true, followups: ["Should clear"] } },
        { type: "tool-suggest_followups", toolCallId: "s1", state: "output-available", output: { prompts: [] } }
      ]
    };
    expect(getFollowups(clearedByEmptySuggest, "ready")).toEqual([]);
  });
});
