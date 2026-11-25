import { z } from "zod";
import { LLM_PROVIDER_IDS } from "@/lib/llm/providers";
import { generateTextWithFallback, probeToolCapability, PROBE_TIMEOUT_MS } from "@/lib/llm/client";
import { isHostedDemo } from "@/lib/config/deployment";
import { probeFailureHint } from "@/lib/llm/probe-outcome";
import { assertHostedProviderRequest, entryFromRequest, hasHeaderApiKey } from "../../_lib/credentials";
import { badRequest, json } from "../../_lib/responses";

export const runtime = "nodejs";

const probeSchema = z.object({
  provider: z.enum(LLM_PROVIDER_IDS),
  baseUrl: z.string().optional(),
  model: z.string().min(1),
  key: z.string().optional(),
  keySource: z.enum(["env", "ui", "none"]).optional()
});

export async function POST(request: Request): Promise<Response> {
  try {
    const body = probeSchema.parse(await request.json());
    assertHostedProviderRequest({ provider: body.provider, baseUrl: body.baseUrl, headers: request.headers });

    const hasHeaderKey = hasHeaderApiKey(request.headers, body.provider);
    const entry = entryFromRequest({
      provider: body.provider,
      model: body.model,
      baseUrl: body.baseUrl,
      apiKey: isHostedDemo() ? undefined : body.key,
      keySource: isHostedDemo() ? "ui" : (body.keySource ?? (body.key || hasHeaderKey ? "ui" : "env"))
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
        hint: probeFailureHint(error)
      });
    }
  } catch (error) {
    return badRequest(error);
  }
}
