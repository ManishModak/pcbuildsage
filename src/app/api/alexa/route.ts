/**
 * src/app/api/alexa/route.ts
 *
 * TEMPORARY STUB owned by Track C (contract §10). Returns a canned UI message
 * stream shaped per contract §§1-3 (one `present_build` tool part carrying the
 * full MCP CallToolResult as its output: two cards, the second with a USD
 * snapshot) so the /alexa page can build against it until Track B's real route
 * lands and replaces this file. The page must not depend on stub-only
 * behaviour: it reads cards from output.structuredContent.cards with a
 * JSON.parse(content[0].text) fallback, exactly as the real route provides.
 */
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { z } from "zod";

export const runtime = "nodejs";

// Mirrors chatRequestSchema in src/app/api/chat/route.ts (contract §1).
const messageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().optional(),
  parts: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional()
});

const alexaRequestSchema = z.object({
  messages: z.array(messageSchema),
  sessionId: z.string().optional(),
  config: z.unknown().optional(),
  compactContext: z.unknown().optional()
});

const STUB_TEXT =
  "Here's a fifty thousand rupee gaming build, plus a cheaper alternative on the card. " +
  "Want me to swap the GPU for something cheaper?";

const STUB_STRUCTURED_CONTENT = {
  presented: true,
  builds: [
    { label: "Stub gaming build", product_ids: ["stub-cpu-1", "stub-gpu-1", "stub-ram-1"] },
    { label: "Stub budget alternative", product_ids: ["stub-cpu-2", "stub-gpu-2", "stub-ram-2"] }
  ],
  cards: [
    {
      label: "Stub gaming build",
      notes: "Canned stub build around fifty thousand rupees.",
      snapshot: {
        components: [
          { category: "cpu", name: "AMD Ryzen 5 5600", price: 13490, currency: "INR", retailer: "MDComputers", url: "https://mdcomputers.in/" },
          { category: "gpu", name: "NVIDIA GeForce RTX 4060 8GB", price: 31500, currency: "INR", retailer: "MDComputers", url: "https://mdcomputers.in/" },
          { category: "ram", name: "Corsair Vengeance 16GB DDR4", price: 2899, currency: "INR", retailer: "MDComputers", url: "https://mdcomputers.in/" }
        ],
        total: 47889,
        subtotal: 47889,
        currency: "INR",
        is_complete: true,
        component_count: 3,
        unpriced_count: 0,
        missing_prices: [],
        currencies: ["INR"],
        parts: {},
        valid: true,
        validation_summary: { passed: 4, failed: 0, unverified: 1, skipped: 0, issues: [] },
        created_at: "2026-10-02T00:00:00.000Z"
      }
    },
    {
      label: "Stub budget alternative",
      notes: "Canned stub build priced in US dollars.",
      snapshot: {
        components: [
          { category: "cpu", name: "AMD Ryzen 5 5600", price: 145, currency: "USD", retailer: "Newegg", url: "https://www.newegg.com/" },
          { category: "gpu", name: "AMD Radeon RX 6600 8GB", price: 199, currency: "USD", retailer: "Newegg", url: "https://www.newegg.com/" },
          { category: "ram", name: "Corsair Vengeance 16GB DDR4", price: 35, currency: "USD", retailer: "Newegg", url: "https://www.newegg.com/" }
        ],
        total: 379,
        subtotal: 379,
        currency: "USD",
        is_complete: true,
        component_count: 3,
        unpriced_count: 0,
        missing_prices: [],
        currencies: ["USD"],
        parts: {},
        valid: true,
        validation_summary: { passed: 3, failed: 0, unverified: 2, skipped: 0, issues: [] },
        created_at: "2026-10-02T00:00:00.000Z"
      }
    }
  ]
};

// Belt and braces (contract §3): the same payload is reachable both as
// structuredContent and as JSON in content[0].text.
const STUB_OUTPUT = {
  content: [{ type: "text", text: JSON.stringify(STUB_STRUCTURED_CONTENT) }],
  structuredContent: STUB_STRUCTURED_CONTENT
};

export async function POST(request: Request): Promise<Response> {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = alexaRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      const messageId = crypto.randomUUID();
      const textId = "stub-text-0";
      writer.write({ type: "start", messageId });
      writer.write({ type: "start-step" });
      writer.write({ type: "text-start", id: textId });
      writer.write({ type: "text-delta", id: textId, delta: STUB_TEXT });
      writer.write({ type: "text-end", id: textId });
      writer.write({
        type: "tool-input-available",
        toolCallId: "stub-present-1",
        toolName: "present_build",
        input: { builds: [{ label: "Stub gaming build" }] }
      });
      writer.write({ type: "tool-output-available", toolCallId: "stub-present-1", output: STUB_OUTPUT });
      writer.write({ type: "finish-step" });
      writer.write({ type: "finish", finishReason: "stop" });
    }
  });
  return createUIMessageStreamResponse({ stream });
}
