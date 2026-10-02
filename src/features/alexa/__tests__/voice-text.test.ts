import { describe, expect, it } from "vitest";
import { hasAssistantReply, latestAssistantText, messageText, shortTranscript } from "../voice-text";

const user = (text: string, id = "u") => ({ id, role: "user", parts: [{ type: "text", text }] });
const sage = (text: string, id = "a") => ({ id, role: "assistant", parts: [{ type: "text", text }] });

describe("messageText", () => {
  it("joins text parts and falls back to string content", () => {
    expect(messageText(sage("hello"))).toBe("hello");
    expect(
      messageText({ role: "assistant", content: "fallback", parts: undefined })
    ).toBe("fallback");
    expect(messageText({ role: "assistant", parts: [{ type: "tool-x", text: "no" }] })).toBe("");
  });
});

describe("latestAssistantText", () => {
  it("returns the newest assistant text", () => {
    expect(latestAssistantText([user("hi", "u1"), sage("first", "a1"), user("more", "u2"), sage("second", "a2")])).toBe("second");
    expect(latestAssistantText([user("hi")])).toBe("");
  });
});

describe("shortTranscript", () => {
  it("excludes the current answer and caps the window", () => {
    const messages = [user("one", "u1"), sage("uno", "a1"), user("two", "u2"), sage("dos", "a2"), user("three", "u3"), sage("tres", "a3")];
    const recent = shortTranscript(messages, 4);
    expect(recent.map((m) => m.id)).toEqual(["a1", "u2", "a2", "u3"]);
    // Current answer "tres" is excluded; window keeps the last 4 before it.
    expect(shortTranscript(messages, 2).map((m) => m.id)).toEqual(["a2", "u3"]);
  });

  it("keeps a trailing user message (nothing to exclude)", () => {
    expect(shortTranscript([sage("uno", "a1"), user("two", "u2")], 6).map((m) => m.id)).toEqual(["a1", "u2"]);
  });
});

describe("hasAssistantReply", () => {
  it("detects speakable assistant text", () => {
    expect(hasAssistantReply([user("hi")])).toBe(false);
    expect(hasAssistantReply([user("hi"), sage("hello")])).toBe(true);
  });
});
