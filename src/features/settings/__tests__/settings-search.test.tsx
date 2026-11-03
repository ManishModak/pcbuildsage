import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findSettings, researchModelOptions, researchModelValue } from "../settings-view";
import { providerKeyState } from "../providers-page";
import { ChainBuilder } from "@/features/llm/chain-builder";
import { getProvider } from "@/lib/llm/providers";
import type { ChainEntry } from "@/types/client";

const main: ChainEntry = { id: "a", provider: "nvidia", model: "nvidia/nemotron", keySource: "env" };
const backup: ChainEntry = { id: "b", provider: "groq", model: "openai/gpt-oss-120b", keySource: "env" };

describe("settings search", () => {
  it("finds a single setting and opens the page it lives on in each mode", () => {
    expect(findSettings("currency", false)).toEqual([{ label: "Currency", tab: "personalization" }]);
    expect(findSettings("currency", true)).toEqual([{ label: "Currency", tab: "market" }]);
    expect(findSettings("share researched", true)).toEqual([]);
    expect(findSettings("  ", false)).toEqual([]);
  });
});

describe("research model picker", () => {
  it("offers every chat-list model and selects the one in use", () => {
    expect(researchModelOptions([main, backup], null).map((o) => o.label)).toEqual([
      "Same as chat",
      "NVIDIA · nvidia/nemotron",
      "Groq · openai/gpt-oss-120b"
    ]);
    expect(researchModelValue([main, backup], null)).toBe("same-as-chat");
    expect(researchModelValue([main, backup], [{ ...backup, id: "subagent-b" }])).toBe("b");
  });

  it("keeps a saved research model that is no longer on the chat list", () => {
    const research = [{ ...backup, id: "subagent-x", model: "old-model" }];
    expect(researchModelValue([main], research)).toBe("current-research");
    expect(researchModelOptions([main], research).at(-1)?.label).toBe("Groq · old-model");
  });
});

describe("providers page", () => {
  it("names where each provider's key comes from", () => {
    const credentials = { llm: { groq: true }, search: {} };
    expect(providerKeyState(getProvider("groq"), credentials, false)).toBe("env");
    expect(providerKeyState(getProvider("groq"), credentials, true)).toBe("saved");
    expect(providerKeyState(getProvider("anthropic"), credentials, false)).toBe("none");
    expect(providerKeyState(getProvider("ollama"), credentials, false)).toBe("local");
  });
});

describe("chat model rows", () => {
  it("shows a ready model as a one-line summary and a new one as the full form", () => {
    const html = renderToStaticMarkup(
      <ChainBuilder chain={[main, { id: "c", provider: "gemini", model: "", keySource: "env" }]} onChange={() => {}} credentials={{ llm: { nvidia: true, gemini: true }, search: {} }} endpoints={[]} />
    );
    expect(html).toContain('aria-label="Edit main model"');
    expect(html).toContain("nvidia/nemotron");
    expect(html).toContain('aria-label="Done editing backup 1"');
    expect(html.match(/Reasoning effort/g)).toHaveLength(1);
  });
});
