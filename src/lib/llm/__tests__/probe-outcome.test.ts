import { describe, expect, it } from "vitest";
import { describeProbeResult, probeFailureHint } from "../probe-outcome";
import type { PingResult } from "@/types/client";
import { ACCESS_BLOCKED_COPY, FREE_LIMIT_COPY, KEY_REJECTED_COPY } from "@/content/api-key-help";

// Hints below are what /api/llm/probe returned for real failures on the dev
// server, or what probeToolCapability (src/lib/llm/client.ts) builds.
const down = (hint: string): PingResult => ({ reachable: false, latencyMs: 200, toolCapable: false, hint });
const noTools = (hint: string, toolProbeReason: string): PingResult =>
  ({ reachable: true, latencyMs: 900, toolCapable: false, hint, toolProbeReason }) as PingResult;

describe("describeProbeResult", () => {
  it("reports a reachable, tool-capable model as ok", () => {
    expect(describeProbeResult({ reachable: true, latencyMs: 640, toolCapable: true }).kind).toBe("ok");
  });

  it.each([
    ["Gemini bad key", down("API key not valid. Please pass a valid API key.")],
    ["Groq bad key", down("Invalid API Key")],
    ["OpenRouter bad key", down("User not found.")],
    ["missing Gemini key", down("Google Generative AI API key is missing. Pass it using the 'apiKey' parameter or the GOOGLE_GENERATIVE_AI_API_KEY environment variable.")],
    ["missing OpenRouter key", down("No cookie auth credentials found")],
    ["tool test 401", noTools(`${KEY_REJECTED_COPY} (Unauthorized) Check you copied the full key into Settings, then test again.`, "request_failed")],
    ["tool test 403", noTools(`${ACCESS_BLOCKED_COPY} (Forbidden) Pick another model or provider, then test again.`, "request_failed")]
  ])("classifies %s as a key problem", (_label, result) => {
    expect(describeProbeResult(result).kind).toBe("key");
  });

  it.each([
    ["tool test 429", noTools(`${FREE_LIMIT_COPY} (Too Many Requests) Wait a bit and test again, or pick another free model.`, "request_failed")],
    ["provider quota", down("Resource has been exhausted (e.g. check quota).")],
    ["demo limiter via the client", down("Request to /api/llm/probe failed: HTTP 429: Rate limit exceeded. Please retry shortly.")]
  ])("classifies %s as quota", (_label, result) => {
    expect(describeProbeResult(result).kind).toBe("quota");
  });

  it.each([
    [
      "text reply instead of a tool call",
      noTools(
        "The model replied in plain text instead of calling the test tool, so it can't use PCBuildSage's tools. Enable tool calling on the backend launch flags or model template.",
        "no_tool_call"
      )
    ],
    ["provider rejects tools", noTools("The tool test request failed (This model does not support tools). Check the endpoint and try again.", "request_failed")]
  ])("classifies %s as a tools problem", (_label, result) => {
    expect(describeProbeResult(result)).toEqual({ kind: "tools", message: "This model can't use tools. Pick one marked Recommended." });
  });

  it.each([
    ["closed port", down("Failed after 2 attempts. Last error: AI_APICallError: Cannot connect to API: bad port")],
    ["browser offline", down("Failed to fetch")],
    ["slow tool test", noTools("The tool test didn't finish in time (The operation was aborted due to timeout). Try again; slow or reasoning models can take a while to answer.", "request_failed")]
  ])("classifies %s as network", (_label, result) => {
    expect(describeProbeResult(result).kind).toBe("network");
  });

  it("falls back to unknown when the server hides the cause", () => {
    const outcome = describeProbeResult(down("All fallback LLM providers failed (1/1 openai-compatible:x)."));
    expect(outcome.kind).toBe("unknown");
    expect(outcome.message).toMatch(/model name/);
    expect(describeProbeResult(down("Provider 'ollama' is not supported in hosted-demo mode.")).kind).toBe("unknown");
  });
});

describe("probeFailureHint", () => {
  it("unwraps a one-entry chain failure so a dead server reads as network", () => {
    const original = new Error("Cannot connect to API: connect ECONNREFUSED 127.0.0.1:8080");
    const annotated = new Error(`[chain 1/1 openai-compatible:x] ${original.message}`, { cause: original });
    const hint = probeFailureHint(new AggregateError([annotated], "All fallback LLM providers failed (1/1 openai-compatible:x)."));
    expect(hint).toBe(original.message);
    expect(describeProbeResult({ reachable: false, latencyMs: 0, toolCapable: false, hint }).kind).toBe("network");
  });

  it("keeps a direct error's message", () => {
    expect(probeFailureHint(new Error("API key not valid. Please pass a valid API key."))).toMatch(/^API key not valid/);
  });
});
