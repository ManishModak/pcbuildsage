import { describe, expect, it, vi } from "vitest";
import { discoverModels, getDiscoveryTimeoutMs, DISCOVERY_CONCURRENCY } from "@/lib/llm/discovery";

describe("discovery timeouts", () => {
  it("defaults to a bounded timeout and honours env", () => {
    expect(getDiscoveryTimeoutMs()).toBeGreaterThan(0);
    expect(getDiscoveryTimeoutMs()).toBeLessThanOrEqual(30_000);
    vi.stubEnv("PCBUILDSAGE_DISCOVERY_TIMEOUT_MS", "2500");
    expect(getDiscoveryTimeoutMs()).toBe(2500);
    vi.unstubAllEnvs();
  });

  it("passes an abort signal so hangs cannot block onboarding", async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: [] }));
    await discoverModels({ provider: "openrouter", model: "x", keySource: "none" }, fetchMock);
    const call = fetchMock.mock.calls[0] as unknown as [string, { signal?: AbortSignal }];
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("discovery concurrency", () => {
  it("caps Ollama /api/show fan-out", async () => {
    expect(DISCOVERY_CONCURRENCY).toBeLessThanOrEqual(8);
    let active = 0;
    let peak = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return Response.json({ models: Array.from({ length: 10 }, (_, index) => ({ name: `m${index}`, model: `m${index}` })) });
      }
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return Response.json({ parameters: "", model_info: { "x.context_length": 8192 } });
    });
    const models = await discoverModels({ provider: "ollama", model: "x", baseUrl: "http://localhost:11434", keySource: "none" }, fetchMock);
    expect(models).toHaveLength(10);
    expect(peak).toBeLessThanOrEqual(DISCOVERY_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });
});
