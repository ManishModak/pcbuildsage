import { afterEach, describe, expect, it, vi } from "vitest";
import { envKeyAllowed } from "../env-key-scope";
import { resolveApiKey } from "../client";
import { entryFromRequest, getCredentialAvailability } from "@/app/api/_lib/credentials";
import { discoverModels } from "../discovery";

describe("env key scope (local mode)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("scopes every cloud provider's .env key to its registry host", () => {
    expect(envKeyAllowed({ provider: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1" })).toBe(true);
    expect(envKeyAllowed({ provider: "nvidia", baseUrl: "https://evil.example/v1" })).toBe(false);
    expect(envKeyAllowed({ provider: "anthropic", baseUrl: "https://evil.example/v1" })).toBe(false);
    expect(envKeyAllowed({ provider: "openai", baseUrl: "https://api.openai.com/v1" })).toBe(true);
  });

  it("reports each provider's own .env key, and local providers by address", () => {
    const availability = getCredentialAvailability({ NVIDIA_API_KEY: "k", OLLAMA_BASE_URL: "http://localhost:11434" } as unknown as NodeJS.ProcessEnv, "local");
    expect(availability.llm.nvidia).toBe(true);
    expect(availability.llm.ollama).toBe(true);
    expect(availability.llm.anthropic).toBe(false);
    expect(availability.llm["openai-compatible"]).toBe(false);
  });

  it("only lets openrouter/groq .env keys go to their official hosts", () => {
    expect(envKeyAllowed({ provider: "openrouter" })).toBe(true);
    expect(envKeyAllowed({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" })).toBe(true);
    expect(envKeyAllowed({ provider: "groq", baseUrl: "https://api.groq.com/openai/v1" })).toBe(true);
    expect(envKeyAllowed({ provider: "groq", baseUrl: "https://evil.example/openai/v1" })).toBe(false);
    expect(envKeyAllowed({ provider: "openrouter", baseUrl: "https://openrouter.ai.evil.example/api/v1" })).toBe(false);
    expect(envKeyAllowed({ provider: "openrouter", baseUrl: "not a url" })).toBe(false);
    // Self-chosen servers keep working with their .env key.
    expect(envKeyAllowed({ provider: "openai-compatible", baseUrl: "https://my-server.example/v1" })).toBe(true);
    expect(envKeyAllowed({ provider: "ollama", baseUrl: "http://localhost:11434" })).toBe(true);
  });

  it("never attaches the key when a request points a cloud provider elsewhere", () => {
    vi.stubEnv("PCBUILDSAGE_DEPLOYMENT_MODE", "local");
    vi.stubEnv("GROQ_API_KEY", "env-groq-key");
    const redirected = { provider: "groq" as const, model: "m", keySource: "env" as const, baseUrl: "https://evil.example/v1" };
    expect(entryFromRequest(redirected, new Headers()).apiKey).toBeUndefined();
    expect(resolveApiKey(redirected, "GROQ_API_KEY")).toBeUndefined();
    expect(resolveApiKey({ ...redirected, baseUrl: undefined }, "GROQ_API_KEY")).toBe("env-groq-key");
  });

  it("model discovery against a foreign baseUrl sends no Authorization header", async () => {
    vi.stubEnv("PCBUILDSAGE_DEPLOYMENT_MODE", "local");
    vi.stubEnv("GROQ_API_KEY", "env-groq-key");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const entry = entryFromRequest({ provider: "groq", model: "__model_discovery__", baseUrl: "https://evil.example/v1" }, new Headers());
    await discoverModels(entry, fetchImpl as unknown as typeof fetch);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit | undefined])[1];
    expect(JSON.stringify(init?.headers ?? {})).not.toContain("env-groq-key");
  });
});
