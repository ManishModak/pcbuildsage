import { describe, expect, it } from "vitest";
import { defaultSuitability, parseParamsBillions, pickFreeToolCapableDefault } from "../model-recommend";

// OpenRouter free tool-capable models, in discovery order (2026-09).
const OPENROUTER_FREE_TOOL_IDS = [
  "inclusionai/ling-3.0-flash-sante:free",
  "inclusionai/ling-3.0-flash-fin:free",
  "qwen/qwen3.8-27b:free",
  "dots-studio/dots-3-note-preview:free",
  "liquid/lfm-2.5-2.6b:free",
  "nvidia/nemotron-3.5-lightning:free",
  "thinkingmachines/inkling-small:free",
  "poolside/laguna-s-2.1:free",
  "thinkingmachines/inkling:free",
  "poolside/laguna-xs-2.1:free",
  "cohere/north-mini-code:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3-super-120b-a12b:free"
];

const free = (id: string) => ({ id, toolCapable: true, free: true });

describe("pickFreeToolCapableDefault", () => {
  it("skips domain-tuned variants and picks the first general free tool-capable model", () => {
    expect(pickFreeToolCapableDefault(OPENROUTER_FREE_TOOL_IDS.map(free))?.id).toBe("qwen/qwen3.8-27b:free");
  });

  it("skips tiny and specialist models even when they come first", () => {
    const ids = ["liquid/lfm-2.5-2.6b:free", "cohere/north-mini-code:free", "thinkingmachines/inkling-small:free", "thinkingmachines/inkling:free"];
    expect(pickFreeToolCapableDefault(ids.map(free))?.id).toBe("thinkingmachines/inkling:free");
  });

  it("prefers a small-name hint over specialist/tiny, and falls back to the old rule when nothing survives", () => {
    const hinted = ["inclusionai/ling-3.0-flash-sante:free", "thinkingmachines/inkling-small:free"];
    expect(pickFreeToolCapableDefault(hinted.map(free))?.id).toBe("thinkingmachines/inkling-small:free");
    const allFiltered = ["inclusionai/ling-3.0-flash-sante:free", "liquid/lfm-2.5-2.6b:free"];
    expect(pickFreeToolCapableDefault(allFiltered.map(free))?.id).toBe("inclusionai/ling-3.0-flash-sante:free");
  });

  it("still prefers free over paid, and a paid tool-capable model over none", () => {
    const models = [
      { id: "openai/gpt-paid", toolCapable: true, free: false },
      free("liquid/lfm-2.5-2.6b:free")
    ];
    expect(pickFreeToolCapableDefault(models)?.id).toBe("liquid/lfm-2.5-2.6b:free");
    expect(pickFreeToolCapableDefault([{ id: "openai/gpt-paid", toolCapable: true, free: false }])?.id).toBe("openai/gpt-paid");
    expect(pickFreeToolCapableDefault([{ id: "x/no-tools", free: true }])).toBeUndefined();
  });
});

describe("default suitability helpers", () => {
  it("parses total parameter counts, ignoring active-param suffixes", () => {
    expect(parseParamsBillions("liquid/lfm-2.5-2.6b:free")).toBe(2.6);
    expect(parseParamsBillions("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free")).toBe(30);
    expect(parseParamsBillions("qwen/qwen3.8-27b:free")).toBe(27);
    expect(parseParamsBillions("nvidia/nemotron-3.5-lightning:free")).toBeUndefined();
  });

  it("ranks general, small-hint and specialist/tiny ids", () => {
    expect(defaultSuitability("inclusionai/ling-3.0-flash-fin:free")).toBe(2);
    expect(defaultSuitability("cohere/north-mini-code:free")).toBe(2);
    expect(defaultSuitability("liquid/lfm-2.5-2.6b:free")).toBe(2);
    expect(defaultSuitability("poolside/laguna-xs-2.1:free")).toBe(1);
    // A parsable size of 20B+ outweighs the "nano" hint.
    expect(defaultSuitability("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free")).toBe(0);
    expect(defaultSuitability("google/gemma-4-31b-it:free")).toBe(0);
    // Token match only: "medium" is not "med".
    expect(defaultSuitability("mistral/mistral-medium-3:free")).toBe(0);
  });
});
