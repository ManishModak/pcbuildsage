import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { markInterruptedToolCalls } from "../interrupted-tools";
import { MessageView, type ChatUIMessage } from "@/features/chat/message";
import type { ToolPart } from "@/features/chat/tool-chip";

/** The stuck shape from a real local session: a validate_build left mid-flight. */
function stuckAssistant(state: string): ChatUIMessage {
  return {
    id: "m2",
    role: "assistant",
    parts: [
      {
        type: "tool-validate_build",
        toolCallId: "call-1",
        state,
        input: { parts: [{ category: "cpu", name: "AMD Ryzen 5 7600" }] }
      } as unknown as ToolPart,
      { type: "text", text: "Here is what I found." }
    ]
  } as unknown as ChatUIMessage;
}

function markupFor(message: ChatUIMessage) {
  return renderToStaticMarkup(<MessageView message={message} versions={[]} />);
}

describe("markInterruptedToolCalls", () => {
  it("turns a stuck tool call in a finished turn into a visible interrupted error", () => {
    const [cleaned] = markInterruptedToolCalls([stuckAssistant("input-streaming")]) as ChatUIMessage[];
    const part = cleaned.parts[0] as ToolPart;

    expect(part.state).toBe("output-error");
    expect(part.errorText).toBe("Interrupted");
    // The half-parsed input is dropped so nothing renders a spinner or a result.
    expect(part.input).toBeUndefined();
    expect(part.output).toBeUndefined();
  });

  it("cleans both in-flight states the AI SDK can leave behind", () => {
    for (const state of ["input-streaming", "input-available"]) {
      const [cleaned] = markInterruptedToolCalls([stuckAssistant(state)]) as ChatUIMessage[];
      expect((cleaned.parts[0] as ToolPart).state, state).toBe("output-error");
    }
  });

  it("leaves a completed tool call alone", () => {
    const message = stuckAssistant("output-available");
    const [cleaned] = markInterruptedToolCalls([message]) as ChatUIMessage[];
    expect(cleaned.parts[0]).toBe(message.parts[0]);
  });

  it("cleans a stuck part in the last message too, since a stored read is never live", () => {
    const messages = [stuckAssistant("input-streaming"), stuckAssistant("input-available")];
    const cleaned = markInterruptedToolCalls(messages) as ChatUIMessage[];

    expect((cleaned[0].parts[0] as ToolPart).state).toBe("output-error");
    expect((cleaned[1].parts[0] as ToolPart).state).toBe("output-error");
    // The input is untouched, so nothing rendered from a live stream is affected.
    expect((messages[1].parts[0] as ToolPart).state).toBe("input-available");
  });

  it("returns the same array when there is nothing to repair", () => {
    const messages = [stuckAssistant("output-available")];
    expect(markInterruptedToolCalls(messages)).toBe(messages);
  });

  it("does not mutate the stored transcript", () => {
    const message = stuckAssistant("input-streaming");
    markInterruptedToolCalls([message]);
    expect((message.parts[0] as ToolPart).state).toBe("input-streaming");
  });

  it("renders no permanent spinner for a stuck call that was loaded", () => {
    const [cleaned] = markInterruptedToolCalls([stuckAssistant("input-streaming")]) as ChatUIMessage[];
    expect(markupFor(cleaned)).not.toContain("pcbs-spin");
  });

  it("would have rendered a permanent spinner without the repair", () => {
    // Guards the assertion above: this is exactly the bug being fixed.
    expect(markupFor(stuckAssistant("input-streaming"))).toContain("pcbs-spin");
  });
});
