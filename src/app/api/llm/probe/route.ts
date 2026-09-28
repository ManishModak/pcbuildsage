import { z } from "zod";
import { generateTextWithFallback, probeToolCapability, PROBE_TIMEOUT_MS } from "@/lib/llm/client";
import { isHostedDemo, validateChatProviderUrl } from "@/lib/config/deployment";
import { entryFromRequest } from "../../_lib/credentials";
import { badRequest, json } from "../../_lib/responses";

export const runtime = "nodejs";

const probeSchema = z.object({
  provider: z.enum(["gemini", "ollama", "openrouter", "openai-compatible", "groq"]),
  baseUrl: z.string().optional(),
  model: z.string().min(1),
  key: z.string().optional(),
  keySource: z.enum(["env", "ui", "none"]).optional()
});

export async function POST(request: Request): Promise<Response> {
  try {
    const body = probeSchema.parse(await request.json());
    if (isHostedDemo()) {
      if (body.provider === "ollama") {
        return badRequest(new Error("Provider 'ollama' is not supported in hosted-demo mode."));
      }
      if (body.baseUrl) {
        const check = validateChatProviderUrl(body.baseUrl, "hosted-demo");
        if (!check.allowed) {
          return badRequest(new Error(check.reason ?? "Custom base URL is not permitted in hosted-demo mode."));
        }
      }
    }
    const hasHeaderKey = Boolean(
      request.headers.get(`x-pcbuildsage-api-key-${body.provider.toLowerCase()}`) ||
      request.headers.get(`x-${body.provider.toLowerCase()}-api-key`)
    );
    const entry = entryFromRequest({
      provider: body.provider,
      model: body.model,
      baseUrl: body.baseUrl,
      apiKey: body.key,
      keySource: body.keySource ?? (body.key || hasHeaderKey ? "ui" : "env")
    }, request.headers);
    const started = Date.now();
    try {
      await generateTextWithFallback({ chain: [entry], prompt: "Reply with ok.", timeoutMsPerEntry: PROBE_TIMEOUT_MS });
      const toolProbe = await probeToolCapability(entry);
      return json({
        reachable: true,
        latencyMs: Date.now() - started,
        toolCapable: toolProbe.ok,
        // "no_tool_call" (model answered in text) vs "request_failed" (the
        // probe request itself failed); hint leads with the plain reason.
        toolProbeReason: toolProbe.ok ? undefined : toolProbe.reason,
        hint: toolProbe.ok ? undefined : [toolProbe.error, ...(toolProbe.remedies ?? [])].filter(Boolean).join(" ")
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
