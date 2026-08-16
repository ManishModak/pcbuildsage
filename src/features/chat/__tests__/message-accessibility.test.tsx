import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MessageView, type ChatUIMessage } from "../message";

describe("message actions", () => {
  it("keeps edit actions available on touch layouts and keyboard focus", () => {
    const message: ChatUIMessage = {
      id: "message-1",
      role: "user",
      parts: [{ type: "text", text: "Use a quieter CPU cooler." }]
    };

    const markup = renderToStaticMarkup(
      <MessageView message={message} currency="USD" onEdit={vi.fn()} />
    );

    expect(markup).toContain("opacity-100");
    expect(markup).toContain("md:group-focus-within:opacity-100");
    expect(markup).toContain("[@media(pointer:coarse)]:opacity-100");
    expect(markup).toContain('type="button"');
    expect(markup).toContain("Edit</span>");
    expect(markup).toContain("Resend</span>");
  });

  it("renders a compact interactive button for presented builds instead of a massive inline table", () => {
    const message: ChatUIMessage = {
      id: "message-2",
      role: "assistant",
      parts: [
        { type: "text", text: "Here is your gaming build recommendation:" },
        {
          type: "tool-present_build",
          toolCallId: "call-1",
          state: "output-available",
          input: {
            builds: [
              {
                label: "Budget 1080p Gaming",
                parts: [
                  { category: "gpu", name: "RTX 4060", price: 28500, currency: "INR", retailer: "MDComputers" },
                  { category: "cpu", name: "Ryzen 5 5600", price: 11200, currency: "INR" }
                ]
              }
            ]
          },
          output: { presented: true, buildCount: 1 }
        } as unknown as ChatUIMessage["parts"][number]
      ]
    };

    const markup = renderToStaticMarkup(
      <MessageView message={message} currency="INR" />
    );

    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-label="View proposed build: Budget 1080p Gaming"');
    expect(markup).toContain("Proposed Build");
    expect(markup).toContain("Budget 1080p Gaming");
    expect(markup).toContain("₹39,700");
    expect(markup).toContain("View Details");
    // Ensure the massive table component row structure is NOT inside the chat message bubble
    expect(markup).not.toContain("Derived requirement");
  });

  it("indicates variant counts when multiple builds are presented in the compact button", () => {
    const message: ChatUIMessage = {
      id: "message-3",
      role: "assistant",
      parts: [
        {
          type: "tool-present_build",
          toolCallId: "call-2",
          state: "output-available",
          input: {
            builds: [
              {
                label: "Performance Build",
                parts: [{ category: "gpu", name: "RTX 4070", price: 55000, currency: "INR" }]
              },
              {
                label: "Value Build",
                parts: [{ category: "gpu", name: "RTX 4060", price: 28500, currency: "INR" }]
              }
            ]
          },
          output: { presented: true, buildCount: 2 }
        } as unknown as ChatUIMessage["parts"][number]
      ]
    };

    const markup = renderToStaticMarkup(
      <MessageView message={message} currency="INR" />
    );

    expect(markup).toContain("2 variants");
    expect(markup).toContain("Performance Build");
  });
});
