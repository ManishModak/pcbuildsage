import { z } from "zod";
import { generateTextWithFallback, probeToolCapability } from "@/lib/llm/client";
import { entryFromRequest } from "../../_lib/credentials";
import { badRequest, json } from "../../_lib/responses";

export const runtime = "nodejs";

const probeSchema = z.object({
  provider: z.enum(["gemini", "ollama", "openrouter", "openai-compatible"]),
  baseUrl: z.string().optional(),
  model: z.string().min(1),
  key: z.string().optional(),
  keySource: z.enum(["env", "ui", "none"]).optional()
});

export async function POST(request: Request): Promise<Response> {
  try {
    const body = probeSchema.parse(await request.json());
    const entry = entryFromRequest({
      provider: body.provider,
      model: body.model,
      baseUrl: body.baseUrl,
      apiKey: body.key,
      keySource: body.keySource ?? (body.key ? "ui" : "env")
    }, request.headers);
    const started = Date.now();
    try {
      await generateTextWithFallback({ chain: [entry], prompt: "Reply with ok." });
      const toolProbe = await probeToolCapability(entry);
      return json({
        reachable: true,
        latencyMs: Date.now() - started,
        toolCapable: toolProbe.ok,
        hint: toolProbe.ok ? undefined : (toolProbe.remedies ?? []).join(" ")
      });
    } catch (error) {
      return json({
        reachable: false,
        latencyMs: Date.now() - started,
        toolCapable: false,
        hint: error instanceof Error ? error.message : String(error)
      });
    }
  } catch (error) {
    return badRequest(error);
  }
}
