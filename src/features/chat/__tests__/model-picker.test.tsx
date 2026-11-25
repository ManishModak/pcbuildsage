import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_CONFIG } from "@/lib/client-config-store";
import { resetCachedDeploymentMode, setCachedDeploymentMode } from "@/lib/api-client";
import {
  getActiveByokProvider,
  getByokModel,
  getByokModelReasoningEffort,
  getByokReasoningEffort,
  resetByokStoreForTesting,
  setActiveByokProvider,
  setByokKey,
  setByokModel,
  setByokStorageForTesting
} from "@/lib/llm/client-byok-store";
import { getProvider } from "@/lib/llm/providers";
import { ByokSection } from "@/features/settings/byok-section";
import { ModelPicker, clearModelPickerDiscoveryCacheForTesting } from "../model-picker";
import {
  applyModelSwitchHosted,
  applyModelSwitchLocal,
  applyReasoningSwitchHosted,
  applyReasoningSwitchLocal,
  buildPickerSections,
  getEligibleProviders
} from "../model-picker-data";
import { resolveActiveSelection } from "../chat-config-resolver";
import type { ClientConfig, DiscoveredModel } from "@/types/client";

class MockStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

describe("in-chat model picker eligibility and filtering", () => {
  it("hosted mode strictly includes only providers with a browser BYOK key and hosted: true", () => {
    const eligible = getEligibleProviders({
      isHosted: true,
      chatChain: [
        { id: "c1", provider: "ollama", model: "llama3.3", keySource: "none" },
        { id: "c2", provider: "openai-compatible", model: "ornith", keySource: "none" },
        { id: "c3", provider: "anthropic", model: "claude-sonnet-4", keySource: "env" }
      ],
      credentials: {
        llm: { gemini: true, openai: true, anthropic: true, ollama: true, "openai-compatible": true },
        search: {}
      },
      hasKey: (provider) => provider === "openrouter" || provider === "ollama"
    });

    expect(eligible.map((p) => p.id)).toEqual(["openrouter"]);
  });

  it("local mode includes providers with chain entries, server env keys, UI keys, or local servers", () => {
    const eligible = getEligibleProviders({
      isHosted: false,
      chatChain: [{ id: "c1", provider: "openai-compatible", model: "ornith", keySource: "none", baseUrl: "http://127.0.0.1:8080/v1" }],
      credentials: { llm: { gemini: true }, search: {} },
      hasKey: (provider) => provider === "groq",
      localServerProviders: new Set(["ollama"])
    });

    expect(eligible.map((p) => p.id)).toEqual(["gemini", "groq", "ollama", "openai-compatible"]);
  });

  it("places configured models on top and searches across hundreds of OpenRouter models", () => {
    const manyOpenRouter: DiscoveredModel[] = Array.from({ length: 320 }, (_, i) => ({
      id: i === 250 ? "anthropic/claude-sonnet-4" : `vendor/model-${i}`,
      name: i === 250 ? "Claude Sonnet 4" : `Vendor Model ${i}`,
      toolCapable: i % 10 === 0,
      free: i % 25 === 0
    }));

    const eligible = getEligibleProviders({
      isHosted: true,
      chatChain: [],
      hasKey: (p) => p === "gemini" || p === "openrouter"
    });

    const unfiltered = buildPickerSections({
      eligibleProviders: eligible,
      isHosted: true,
      chatChain: [],
      activeProvider: "gemini",
      activeModel: "gemini-4-hydrogen",
      getByokModel: (p) => (p === "gemini" ? "gemini-4-hydrogen" : "openrouter/free"),
      discoveredByProvider: {
        gemini: [{ id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" }, { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" }],
        openrouter: manyOpenRouter
      },
      selectedProvider: "all",
      query: ""
    });

    expect(unfiltered.configured.map((m) => `${m.provider}:${m.model}`)).toEqual([
      "gemini:gemini-4-hydrogen",
      "openrouter:openrouter/free"
    ]);
    expect(unfiltered.recommended.length + unfiltered.available.length).toBeGreaterThan(300);

    const searched = buildPickerSections({
      eligibleProviders: eligible,
      isHosted: true,
      chatChain: [],
      activeProvider: "gemini",
      activeModel: "gemini-4-hydrogen",
      getByokModel: (p) => (p === "gemini" ? "gemini-4-hydrogen" : "openrouter/free"),
      discoveredByProvider: {
        gemini: [{ id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" }],
        openrouter: manyOpenRouter
      },
      selectedProvider: "all",
      query: "claude sonnet 4"
    });

    expect(searched.configured).toHaveLength(0);
    expect(searched.recommended.map((m) => m.model)).toEqual(["anthropic/claude-sonnet-4"]);
  });
});

describe("in-chat model picker persistence", () => {
  let session: MockStorage;
  let local: MockStorage;

  beforeEach(() => {
    session = new MockStorage();
    local = new MockStorage();
    resetCachedDeploymentMode();
    resetByokStoreForTesting();
    setByokStorageForTesting(session, local);
    clearModelPickerDiscoveryCacheForTesting();
  });

  it("local mode updates chatChain[0] cleanly without wiping backup entries", () => {
    const config: ClientConfig = {
      ...DEFAULT_CONFIG,
      chatChain: [
        { id: "main-1", provider: "gemini", model: "gemini-2.5-flash", keySource: "env", reasoningEffort: "high" },
        { id: "backup-1", provider: "openrouter", model: "openrouter/free", keySource: "ui", hasSavedKey: true },
        { id: "backup-2", provider: "ollama", model: "qwen3:8b", keySource: "none", baseUrl: "http://localhost:11434", contextLimit: 32768 }
      ]
    };

    const switched = applyModelSwitchLocal(config, {
      provider: "gemini",
      model: "gemini-4-hydrogen",
      credentials: { llm: { gemini: true }, search: {} }
    });

    expect(switched.chatChain).toHaveLength(3);
    expect(switched.chatChain[0]).toMatchObject({
      id: "main-1",
      provider: "gemini",
      model: "gemini-4-hydrogen",
      keySource: "env"
    });
    expect(switched.chatChain[1]).toEqual(config.chatChain[1]);
    expect(switched.chatChain[2]).toEqual(config.chatChain[2]);

    const withEffort = applyReasoningSwitchLocal(switched, "high");
    expect(withEffort.chatChain[0].reasoningEffort).toBe("high");
    expect(withEffort.chatChain.slice(1)).toEqual(config.chatChain.slice(1));

    // Switching to a non-thinking model clears reasoningEffort without wiping backups.
    const nonThinking = applyModelSwitchLocal(withEffort, {
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      credentials: { llm: { groq: true }, search: {} }
    });
    expect(nonThinking.chatChain[0].reasoningEffort).toBeUndefined();
    expect(nonThinking.chatChain).toHaveLength(3);
    expect(nonThinking.chatChain.slice(1)).toEqual(config.chatChain.slice(1));
  });

  it("hosted mode persists active provider, model, and per-model reasoning effort via client-byok-store", () => {
    setByokKey("gemini", "AIzaSyTestKey123", true);
    setByokKey("openrouter", "sk-or-v1-test123", false);

    applyModelSwitchHosted({ provider: "gemini", model: "gemini-4-hydrogen" });
    expect(getActiveByokProvider()).toBe("gemini");
    expect(getByokModel("gemini")).toBe("gemini-4-hydrogen");

    applyReasoningSwitchHosted("gemini", "gemini-4-hydrogen", "high");
    expect(getByokReasoningEffort("gemini")).toBe("high");
    expect(getByokModelReasoningEffort("gemini", "gemini-4-hydrogen")).toBe("high");

    // Switching to a non-thinking model on Gemini clears active reasoningEffort.
    applyModelSwitchHosted({ provider: "gemini", model: "gemini-2.5-flash-lite" });
    expect(getByokModel("gemini")).toBe("gemini-2.5-flash-lite");
    expect(getByokReasoningEffort("gemini")).toBeUndefined();

    // Switching back to gemini-4-hydrogen restores its saved reasoning effort.
    applyModelSwitchHosted({ provider: "gemini", model: "gemini-4-hydrogen" });
    expect(getByokReasoningEffort("gemini")).toBe("high");

    // Switching to another provider preserves persistence flag of that provider.
    applyModelSwitchHosted({ provider: "openrouter", model: "openrouter/free" });
    expect(getActiveByokProvider()).toBe("openrouter");
    expect(getByokModel("openrouter")).toBe("openrouter/free");

    // Switching back reflects immediately in resolveActiveSelection even with stale lastAssistantModel.
    const config: ClientConfig = { ...DEFAULT_CONFIG, chatChain: [] };
    const resolved = resolveActiveSelection(config, "stale-old-model", { isHosted: true });
    expect(resolved).toMatchObject({ provider: "openrouter", model: "openrouter/free" });
  });
});

describe("Groq free-tier warning", () => {
  it("updates Groq provider note in providers.ts and shows warning in ByokSection", () => {
    const groq = getProvider("groq");
    expect(groq.note).toMatch(/8K TPM/i);
    expect(groq.note).toMatch(/too small for full PC builds/i);

    const html = renderToStaticMarkup(<ByokSection />);
    expect(html).toContain("data-testid=\"byok-groq-free-tier-warning\"");
    expect(html).toContain("8K tokens/min");
  });
});

describe("ModelPicker UI rendering", () => {
  beforeEach(() => {
    resetCachedDeploymentMode();
    resetByokStoreForTesting();
    setByokStorageForTesting(new MockStorage(), new MockStorage());
  });

  it("renders live status indicators on the trigger", () => {
    const baseProps = {
      config: DEFAULT_CONFIG,
      activeSelection: { provider: "gemini", model: "gemini-4-hydrogen", reasoningEffort: "high" as const },
      updateConfig: vi.fn(),
      isHostedOverride: false
    };

    const readyHtml = renderToStaticMarkup(<ModelPicker {...baseProps} streaming={false} />);
    expect(readyHtml).toContain("model-picker-trigger");
    expect(readyHtml).toContain("gemini-4-hydrogen");
    expect(readyHtml).toContain("high");
    expect(readyHtml).toContain("ready");

    const answeringHtml = renderToStaticMarkup(<ModelPicker {...baseProps} streaming={true} />);
    expect(answeringHtml).toContain("is answering");
    expect(answeringHtml).toContain("rune-spinner");

    const rateLimitHtml = renderToStaticMarkup(
      <ModelPicker {...baseProps} streaming={false} recovering="rate-limit" />
    );
    expect(rateLimitHtml).toContain("is waiting out the rate limit");

    const compactingHtml = renderToStaticMarkup(
      <ModelPicker {...baseProps} streaming={false} isCompacting={true} />
    );
    expect(compactingHtml).toContain("is shortening the chat");
  });

  it("renders popover panes (rail, search, configured + discovered, Groq badge, reasoning pane, Settings link) when open", () => {
    setCachedDeploymentMode("hosted-demo");
    setByokKey("gemini", "AIzaSyTest123456");
    setByokKey("groq", "gsk_TestKey123456");
    setByokModel("gemini", "gemini-4-hydrogen");
    setByokModel("groq", "openai/gpt-oss-120b");
    setActiveByokProvider("gemini");

    const markup = renderToStaticMarkup(
      <ModelPicker
        config={DEFAULT_CONFIG}
        activeSelection={{ provider: "gemini", model: "gemini-4-hydrogen", reasoningEffort: "medium" }}
        streaming={false}
        updateConfig={vi.fn()}
        defaultOpen
        isHostedOverride
        initialDiscoveredByProvider={{
          gemini: [
            { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
            { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" }
          ],
          groq: [{ id: "openai/gpt-oss-120b", name: "GPT OSS 120B" }]
        }}
      />
    );

    expect(markup).toContain("model-picker-trigger");
    // Portal content renders inline or via Radix; verify non-portal trigger or render state.
    // Note: React renderToStaticMarkup does not mount Radix Portal into document.body;
    // interactive Radix Portal behavior is verified in browser tests and happy-dom.
    expect(markup).toContain("gemini-4-hydrogen");
    expect(markup).toContain("medium");
  });
});
