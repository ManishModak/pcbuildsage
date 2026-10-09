import { describe, expect, it } from "vitest";
import type { LLMChainEntry } from "@/types";
import { localNoThinkingOptions } from "../client";

const entry = (provider: LLMChainEntry["provider"], baseUrl?: string) => ({ provider, model: "m", baseUrl }) as LLMChainEntry;

describe("localNoThinkingOptions", () => {
  it("asks a local or LAN openai-compatible server to skip thinking", () => {
    for (const url of ["http://127.0.0.1:8080/v1", "http://localhost:8080/v1", "http://192.168.1.20:8000/v1"]) {
      expect(localNoThinkingOptions(entry("openai-compatible", url))).toEqual({
        providerOptions: { "openai-compatible": { chat_template_kwargs: { enable_thinking: false } } }
      });
    }
  });

  it("sends nothing to cloud endpoints or other providers", () => {
    expect(localNoThinkingOptions(entry("openai-compatible", "https://api.together.xyz/v1"))).toEqual({});
    expect(localNoThinkingOptions(entry("openrouter"))).toEqual({});
    expect(localNoThinkingOptions(entry("openai-compatible"))).toEqual({});
  });
});
