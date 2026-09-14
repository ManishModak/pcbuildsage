import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
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
    const markup = renderToStaticMarkup(<MessageView message={message} currency="USD" />);
    expect(markup).not.toContain("suggest_followups");
    expect(markup).not.toContain("Make it quieter");
    expect(formatMarkdownTranscript({ messages: [message] })).toContain("suggest_followups");
  });

  it("places accessible prompt buttons below the answer", () => {
    const markup = renderToStaticMarkup(<MessageView message={message} currency="USD" followups={["Make it quieter"]} onFollowup={vi.fn()} />);
    expect(markup).toContain('aria-label="Suggested follow-ups"');
    expect(markup).toContain('type="button"');
    expect(markup).toContain("focus-visible:outline");
    expect(markup.indexOf("Make it quieter")).toBeGreaterThan(markup.indexOf("Your completed answer."));
  });
});
