import { afterEach, describe, expect, it, vi } from "vitest";
import { envKeyAllowed } from "../env-key-scope";
import { resolveApiKey } from "../client";
import { entryFromRequest } from "@/app/api/_lib/credentials";
import { discoverModels } from "../discovery";

describe("env key scope (local mode)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
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
