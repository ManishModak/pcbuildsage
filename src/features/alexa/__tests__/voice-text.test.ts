import { describe, expect, it } from "vitest";
import { answerText, currentTurnAnswer, messageText, plainSpeech, shortTranscript, spokenSummary } from "../voice-text";

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

describe("currentTurnAnswer", () => {
  it("is the newest assistant answer, and empty while a new turn is pending", () => {
    expect(currentTurnAnswer([user("hi", "u1"), sage("first", "a1"), user("more", "u2"), sage("second", "a2")])).toBe("second");
    // The user just spoke: the previous turn's answer must not resurface.
    expect(currentTurnAnswer([user("hi", "u1"), sage("first", "a1"), user("more", "u2")])).toBe("");
    expect(currentTurnAnswer([user("hi")])).toBe("");
  });
});

// A real Ornith 9B final answer from a voice turn (2026-10-09), shortened.
const LONG_ANSWER = [
  "Here's your gaming PC under ₹70k. The **recommended build (₹66,520)** centers on the **RX 7600 8GB**, which is the clear value pick — for ₹7,150 more than the budget build you get a much stronger GPU.",
  "",
  "**Both builds share:** Ryzen 5 5500 (6C/12T), ASRock A520M-HVS M-ATX board, Patriot 16GB (2×8GB) DDR4-3200.",
  "",
  "**A few things to verify before buying:**",
  "- **CPU cooler is not included.** The Ryzen 5 5500 ships with a stock cooler.",
  "- **A520 BIOS check.** Boards made since 2023 usually ship compatible."
].join("\n");

describe("plainSpeech", () => {
  it("drops markdown that reads badly aloud", () => {
    expect(plainSpeech("**Bold** and _it_ with `code`, a [link](https://x.y) and\n- a bullet\n| a | table |")).toBe(
      "Bold and it with code, a link and a bullet"
    );
  });
});

describe("spokenSummary", () => {
  it("keeps the opening sentences within the word budget, without markdown", () => {
    const spoken = spokenSummary(LONG_ANSWER);
    expect(spoken).toBe(
      "Here's your gaming PC under ₹70k. The recommended build (₹66,520) centers on the RX 7600 8GB, which is the clear value pick — for ₹7,150 more than the budget build you get a much stronger GPU."
    );
    expect(spokenSummary(LONG_ANSWER, 30)).toBe("Here's your gaming PC under ₹70k.");
    expect(spoken.split(/\s+/).length).toBeLessThanOrEqual(40);
  });

  it("doesn't split on price abbreviations or decimals", () => {
    expect(spokenSummary("It costs Rs. 21,645 and boosts to 4.6 GHz. Want a cheaper one?")).toBe(
      "It costs Rs. 21,645 and boosts to 4.6 GHz. Want a cheaper one?"
    );
  });

  it("keeps a short closing question after the opening sentences", () => {
    const answer =
      "The three builds are live in the card above. My pick is **Within budget** at ₹66,755 — an RTX 5050 with 8GB that handles 1080p gaming comfortably. The **Max GPU** build (₹75,610) swaps in an RTX 5060.\n\nWant me to keep it within 70k, or spend a bit more for the stronger 5060?";
    expect(spokenSummary(answer)).toBe(
      "The three builds are live in the card above. My pick is Within budget at ₹66,755 — an RTX 5050 with 8GB that handles 1080p gaming comfortably. The Max GPU build (₹75,610) swaps in an RTX 5060. Want me to keep it within 70k, or spend a bit more for the stronger 5060?"
    );
    // A tighter budget drops middle sentences but keeps the question.
    expect(spokenSummary(answer, 20)).toBe(
      "The three builds are live in the card above. Want me to keep it within 70k, or spend a bit more for the stronger 5060?"
    );
  });

  it("trims a single run-on sentence at a clause break", () => {
    const runOn = `The RX 7600 is the pick, ${"with plenty of detail ".repeat(20)}and more`;
    const spoken = spokenSummary(runOn, 10);
    expect(spoken).toBe("The RX 7600 is the pick.");
  });
});

describe("answerText", () => {
  it("keeps only the text after the last tool call", () => {
    const turn = {
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "text", text: "Let me check the catalog." },
        { type: "dynamic-tool", toolName: "search_products", state: "output-available" },
        { type: "step-start" },
        { type: "text", text: "Validating now." },
        { type: "tool-validate_build", state: "output-available" },
        { type: "step-start" },
        { type: "text", text: "Here's a 68k build with an RX 7600." }
      ]
    };
    expect(answerText(turn)).toBe("Here's a 68k build with an RX 7600.");
    expect(currentTurnAnswer([user("hi"), turn])).toBe("Here's a 68k build with an RX 7600.");
  });

  it("shows the latest step's text until the final step speaks", () => {
    const running = {
      role: "assistant",
      parts: [{ type: "text", text: "Let me check the catalog." }, { type: "dynamic-tool", toolName: "search_products", state: "input-available" }]
    };
    expect(answerText(running)).toBe("Let me check the catalog.");
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
