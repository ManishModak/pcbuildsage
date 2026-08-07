import { z } from "zod";
import { discoverModels } from "@/lib/llm/discovery";
import { entryFromRequest } from "../_lib/credentials";
import { badRequest, json, serverError } from "../_lib/responses";

export const runtime = "nodejs";

const providerSchema = z.enum(["gemini", "ollama", "openrouter", "openai-compatible"]);

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const provider = providerSchema.parse(url.searchParams.get("provider"));
    const baseUrl = url.searchParams.get("baseUrl") ?? undefined;
    const model = url.searchParams.get("model") ?? "__model_discovery__";
    const keySource = url.searchParams.get("keySource") ?? (hasApiKeyHeader(request.headers, provider) ? "ui" : "env");
    const entry = entryFromRequest({ provider, model, baseUrl, keySource }, request.headers);
    return json({ models: await discoverModels(entry) });
  } catch (error) {
    if (error instanceof z.ZodError) return badRequest(error);
    return serverError(error);
  }
}

function hasApiKeyHeader(headers: Headers, provider: string): boolean {
  const underscore = provider.replace(/-/g, "_");
  return Boolean(
    headers.get(`x-pcbuildsage-api-key-${provider}`) ??
    headers.get(`x-pcbuildsage-api-key-${underscore}`) ??
    headers.get(`x-${provider}-api-key`) ??
    headers.get(`x-${underscore}-api-key`)
  );
}
