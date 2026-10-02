import { describe, expect, it } from "vitest";
import { POST } from "../route";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/alexa", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

/** Decode the SSE `data:` frames of a UI message stream response. */
async function readChunks(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  const chunks: Array<Record<string, unknown>> = [];
  for (const frame of text.split("\n\n")) {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]" || payload === "") continue;
      chunks.push(JSON.parse(payload) as Record<string, unknown>);
    }
  }
  return chunks;
}

describe("POST /api/alexa (Track C stub, contract §10)", () => {
  it("returns 400 for a body without messages", async () => {
    const response = await POST(makeRequest({ config: {} }));
    expect(response.status).toBe(400);
  });

  it("streams a canned reply with one present_build tool part (two cards, second USD)", async () => {
    const response = await POST(
      makeRequest({
        messages: [{ role: "user", parts: [{ type: "text", text: "Gaming build under 50000" }] }],
        sessionId: crypto.randomUUID()
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const chunks = await readChunks(response);
    const text = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => c.delta as string)
      .join("");
    expect(text.length).toBeGreaterThan(0);

    const outputs = chunks.filter((c) => c.type === "tool-output-available");
    expect(outputs).toHaveLength(1);
    expect(outputs[0].toolCallId).toBeTruthy();

    const inputs = chunks.filter((c) => c.type === "tool-input-available");
    expect(inputs).toHaveLength(1);
    expect(inputs[0].toolName).toBe("present_build");

    const output = outputs[0].output as {
      content: Array<{ type: string; text: string }>;
      structuredContent: { presented: boolean; cards: Array<{ label: string; snapshot: { currency: string } }> };
    };
    // structuredContent path (what the page reads first)…
    expect(output.structuredContent.presented).toBe(true);
    expect(output.structuredContent.cards).toHaveLength(2);
    expect(output.structuredContent.cards[1].snapshot.currency).toBe("USD");
    // …and the belt-and-braces JSON fallback path (contract §3).
    const fallback = JSON.parse(output.content[0].text) as typeof output.structuredContent;
    expect(fallback.cards).toHaveLength(2);
    expect(fallback.cards[1].snapshot.currency).toBe("USD");
  });
});
