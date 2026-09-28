/**
 * What POST /api/chat records: chat_started once per chat (first user
 * message only), and provider_used as an allow-listed provider id with no
 * model id (client-sent free text).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  recorded: [] as Array<[string, string]>,
  provider: "gemini" as string,
  model: "gemini-2.5-flash"
}));

vi.mock("@/lib/analytics/store", () => ({
  record: (event: string, dimension: string) => state.recorded.push([event, dimension]),
  flushInBackground: () => {}
}));

vi.mock("@/lib/llm/chat-engine", () => ({
  streamChat: async () => ({
    provider: state.provider,
    model: state.model,
    fallbackIndex: 0,
    responseMessageId: "r1",
    toUIMessageStreamResponse: () => new Response("ok")
  })
}));

import { POST } from "@/app/api/chat/route";

function chatRequest(roles: Array<"user" | "assistant">): Request {
  return new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: roles.map((role, index) => ({ id: `m${index}`, role, parts: [{ type: "text", text: "hi" }] }))
    })
  });
}

beforeEach(() => {
  state.recorded = [];
  state.provider = "gemini";
  state.model = "gemini-2.5-flash";
});

describe("chat route analytics", () => {
  it("counts chat_started only for the first user message", async () => {
    await POST(chatRequest(["user"]));
    await POST(chatRequest(["user", "assistant", "user"]));
    expect(state.recorded.filter(([event]) => event === "chat_started")).toHaveLength(1);
  });

  it("records the provider id only, never the model id", async () => {
    state.model = "AIzaSyDUMMYKEYDUMMYKEYDUMMYKEY12345";
    await POST(chatRequest(["user"]));
    expect(state.recorded).toContainEqual(["provider_used", "gemini"]);
    expect(JSON.stringify(state.recorded).toLowerCase()).not.toContain("aizasy");
  });

  it("maps an unknown provider to 'other'", async () => {
    state.provider = "sk-or-v1-pasted-key-here";
    await POST(chatRequest(["user"]));
    expect(state.recorded).toContainEqual(["provider_used", "other"]);
    expect(JSON.stringify(state.recorded)).not.toContain("sk-or");
  });
});
