/**
 * Track B: POST /api/alexa request validation (same body contract as /api/chat).
 * Full-stream behaviour is covered at the adapter (mcp-tools) and engine
 * (chat-engine-alexa) levels; these route tests pin the error envelope
 * without needing model keys.
 */
import { describe, expect, it } from "vitest";
import { POST } from "../route";

function post(body: unknown): Request {
  return new Request("http://localhost:3000/api/alexa", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

describe("POST /api/alexa validation", () => {
  it("rejects a body without messages like /api/chat", async () => {
    const res = await POST(post({ sessionId: "s1" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  it("rejects malformed JSON", async () => {
    const res = await POST(post("{not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  it("rejects unknown roles", async () => {
    const res = await POST(post({ messages: [{ role: "tool", content: "x" }] }));
    expect(res.status).toBe(400);
  });
});
