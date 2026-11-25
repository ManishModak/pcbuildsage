import { z } from "zod";
import { LLM_PROVIDER_IDS } from "@/lib/llm/providers";
import { discoverModels } from "@/lib/llm/discovery";
import { isHostedDemo } from "@/lib/config/deployment";
import { UnsafeConfigError, assertHostedProviderRequest, entryFromRequest, hasHeaderApiKey } from "../_lib/credentials";
import { badRequest, json, serverError } from "../_lib/responses";

export const runtime = "nodejs";

const providerSchema = z.enum(LLM_PROVIDER_IDS);

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const provider = providerSchema.parse(url.searchParams.get("provider"));
    const baseUrl = url.searchParams.get("baseUrl") ?? undefined;
    assertHostedProviderRequest({ provider, baseUrl, headers: request.headers });

    const model = url.searchParams.get("model") ?? "__model_discovery__";
    const keySource = isHostedDemo()
      ? "ui"
      : (url.searchParams.get("keySource") ?? (hasHeaderApiKey(request.headers, provider) ? "ui" : "env"));
    const entry = entryFromRequest({ provider, model, baseUrl, keySource }, request.headers);
    return json({ models: await discoverModels(entry) });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof UnsafeConfigError) return badRequest(error);
    return serverError(error);
  }
}
