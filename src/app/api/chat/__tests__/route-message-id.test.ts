import { beforeEach, describe, expect, it, vi } from "vitest";

// Real continuationMessageId; streamChat stubbed to mirror its id rule
// (responseMessageId ?? fresh UUID) and expose the id the route streams.
vi.mock("@/lib/llm/chat-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/chat-engine")>();
  return {
    ...actual,
    streamChat: vi.fn(async (...args: unknown[]) => {
      const responseMessageId = (args[5] as string | undefined) ?? "fresh-id";
      return {
        provider: "gemini",
        model: "gemini-2.0-flash",
        fallbackIndex: 0,
        responseMessageId,
        compactContext: null,
        toUIMessageStreamResponse: (opts: { generateMessageId: () => string }) =>
          Response.json({ messageId: opts.generateMessageId() })
      };
    })
  };
});

import { POST } from "../route";
import { streamChat } from "@/lib/llm/chat-engine";

async function post(messages: unknown[]): Promise<string> {
  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages })
    })
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { messageId: string }).messageId;
}

describe("POST /api/chat response message id", () => {
  beforeEach(() => vi.mocked(streamChat).mockClear());

  it("continues the partial assistant message when it is last (recovery resend)", async () => {
    const id = await post([
      { id: "u1", role: "user", parts: [{ type: "text", text: "1080p build" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Searching" }] }
    ]);
    expect(id).toBe("a1");
    expect(vi.mocked(streamChat).mock.calls[0]?.[5]).toBe("a1");
  });

  it("uses a fresh id when the last message is from the user", async () => {
    const id = await post([
      { id: "a0", role: "assistant", parts: [{ type: "text", text: "Hi" }] },
      { id: "u1", role: "user", parts: [{ type: "text", text: "1080p build" }] }
    ]);
    expect(id).toBe("fresh-id");
    expect(vi.mocked(streamChat).mock.calls[0]?.[5]).toBeUndefined();
  });
});
