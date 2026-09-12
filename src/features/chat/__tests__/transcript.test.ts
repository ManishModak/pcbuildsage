import { describe, expect, it } from "vitest";
import { formatMarkdownTranscript, formatJsonTranscript } from "../transcript";
import type { ChatUIMessage } from "../message";

describe("transcript utilities", () => {
  const sampleMessages: ChatUIMessage[] = [
    {
      id: "msg-1",
      role: "user",
      parts: [{ type: "text", text: "Best 1440p gaming build for INR 90,000" }]
    },
    {
      id: "msg-2",
      role: "assistant",
      parts: [
        {
          type: "reasoning",
          text: "User is looking for a gaming build targeting 1440p resolution within ₹90k."
        },
        {
          type: "tool-search_products",
          toolCallId: "call-1",
          state: "output-available",
          input: {
            term: "air cooler",
            category: "cooler",
            in_stock: true,
            limit: 20
          },
          output: [
            {
              name: "Deepcool AK400",
              priceMinor: 245000,
              currency: "INR"
            }
          ]
        },
        {
          type: "text",
          text: "Here is a balanced 1440p gaming build recommendation based on current stock."
        }
      ]
    }
  ];

  it("formats a comprehensive Markdown transcript", () => {
    const md = formatMarkdownTranscript({
      id: "session-123",
      title: "1440p Gaming Rig",
      messages: sampleMessages,
      modelName: "nex-n2.5-pro:free",
      currency: "INR",
      countryCode: "IN"
    });

    expect(md).toContain("# PCBuildSage Chat: 1440p Gaming Rig");
    expect(md).toContain("- **Session ID**: `session-123`");
    expect(md).toContain("- **Model**: nex-n2.5-pro:free (`nex-n2.5-pro:free`)");
    expect(md).toContain("- **Currency**: INR");
    expect(md).toContain("- **Market**: IN");

    // User section
    expect(md).toContain("## 👤 User");
    expect(md).toContain("Best 1440p gaming build for INR 90,000");

    // Assistant section
    expect(md).toContain("## 🤖 Assistant (nex-n2.5-pro:free)");
    expect(md).toContain("<summary>Thinking Process</summary>");
    expect(md).toContain("User is looking for a gaming build targeting 1440p");

    // Tool call section
    expect(md).toContain("> 🛠️ **Tool Call**: `search_products` [output-available]");
    expect(md).toContain('"term": "air cooler"');
    expect(md).toContain('"Deepcool AK400"');

    // Assistant text
    expect(md).toContain("Here is a balanced 1440p gaming build recommendation");
  });

  it("includes runtime / provider error in markdown transcript", () => {
    const md = formatMarkdownTranscript({
      title: "Broken Run",
      messages: sampleMessages,
      modelName: "nex-n2.5-pro:free",
      error: new Error("Provider returned error (503 Service Unavailable)")
    });

    expect(md).toContain("> ⚠️ **Provider / Runtime Error**:");
    expect(md).toContain("HTTP 503");
  });

  it("formats structured JSON transcript correctly", () => {
    const jsonStr = formatJsonTranscript({
      id: "session-456",
      title: "Test JSON Transcript",
      messages: sampleMessages,
      modelName: "gemini-2.5-flash",
      currency: "USD",
      error: "Rate limit exceeded"
    });

    const parsed = JSON.parse(jsonStr);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.session.id).toBe("session-456");
    expect(parsed.session.title).toBe("Test JSON Transcript");
    expect(parsed.session.model).toBe("gemini-2.5-flash");
    expect(parsed.session.currency).toBe("USD");
    expect(parsed.error).toContain("Rate limit or quota reached (HTTP 429)");
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0].role).toBe("user");
    expect(parsed.messages[1].role).toBe("assistant");
  });

  it("handles string content in older or unnormalized messages", () => {
    const fallbackMessage = [
      {
        id: "msg-plain",
        role: "user" as const,
        content: "Raw content text without parts array",
        parts: []
      }
    ];

    const md = formatMarkdownTranscript({
      messages: fallbackMessage
    });

    expect(md).toContain("Raw content text without parts array");
  });
});
