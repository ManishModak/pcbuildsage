// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_CONFIG } from "@/lib/client-config-store";
import { resetCachedDeploymentMode } from "@/lib/api-client";
import {
  getActiveByokProvider,
  getByokModel,
  getByokReasoningEffort,
  resetByokStoreForTesting,
  setActiveByokProvider,
  setByokKey,
  setByokModel,
  setByokStorageForTesting
} from "@/lib/llm/client-byok-store";
import { ModelPicker, clearModelPickerDiscoveryCacheForTesting } from "../model-picker";
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

describe("ModelPicker DOM interactions", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ models: [], llm: {}, search: {} })
      }))
    );
    resetCachedDeploymentMode();
    resetByokStoreForTesting();
    setByokStorageForTesting(new MockStorage(), new MockStorage());
    clearModelPickerDiscoveryCacheForTesting();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (root) {
      const mountedRoot = root;
      act(() => {
        mountedRoot.unmount();
      });
      root = null;
    }
    container?.remove();
    container = undefined;
    document.body.innerHTML = "";
  });

  it("renders configured models on top, filters 300+ models by search, shows Groq warning, and hides reasoning for Groq", () => {
    setByokKey("gemini", "AIzaSyTest123456");
    setByokKey("groq", "gsk_TestKey123456");
    setByokKey("openrouter", "sk-or-v1-TestKey123456");
    setByokModel("gemini", "gemini-4-hydrogen");
    setByokModel("groq", "openai/gpt-oss-120b");
    setByokModel("openrouter", "openrouter/free");
    setActiveByokProvider("gemini");

    const openrouterModels: DiscoveredModel[] = Array.from({ length: 260 }, (_, i) => ({
      id: i === 220 ? "deepseek/deepseek-r1:free" : `vendor/model-${i}`,
      name: i === 220 ? "DeepSeek R1 Free" : `Vendor Model ${i}`,
      toolCapable: i % 10 === 0,
      free: i === 220
    }));

    const discovered: Record<string, DiscoveredModel[]> = {
      gemini: [
        { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
        { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite" }
      ],
      groq: [{ id: "openai/gpt-oss-120b", name: "GPT OSS 120B" }],
      openrouter: openrouterModels
    };

    root = createRoot(container!);
    act(() => {
      root!.render(
        <ModelPicker
          config={DEFAULT_CONFIG}
          activeSelection={{ provider: "gemini", model: "gemini-4-hydrogen", reasoningEffort: "medium" }}
          streaming={false}
          updateConfig={vi.fn()}
          defaultOpen
          isHostedOverride
          initialDiscoveredByProvider={discovered}
        />
      );
    });

    const popover = document.body.querySelector('[data-testid="model-picker-popover"]');
    expect(popover).not.toBeNull();
    expect(popover?.textContent).toContain("Configured");
    expect(popover?.textContent).toContain("8K TPM free limit");
    expect(popover?.querySelector('[data-testid="model-picker-settings-link"]')?.getAttribute("href")).toBe("/settings?tab=llm");

    // Gemini 4 supports reasoning -> reasoning pane is shown.
    expect(popover?.querySelector('[data-testid="model-picker-reasoning-pane"]')).not.toBeNull();

    // Search across OpenRouter's 260 models.
    const searchInput = popover?.querySelector('[data-testid="model-picker-search"]') as HTMLInputElement;
    expect(searchInput).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(searchInput, "deepseek r1");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(popover?.querySelector('[data-testid="picker-model-openrouter-deepseek/deepseek-r1:free"]')).not.toBeNull();

    // Re-render with Groq active -> reasoning pane is hidden and Groq banner is shown.
    act(() => {
      root!.render(
        <ModelPicker
          config={DEFAULT_CONFIG}
          activeSelection={{ provider: "groq", model: "openai/gpt-oss-120b" }}
          streaming={false}
          updateConfig={vi.fn()}
          defaultOpen
          isHostedOverride
          initialDiscoveredByProvider={discovered}
        />
      );
    });

    expect(document.body.querySelector('[data-testid="model-picker-reasoning-pane"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="groq-free-tier-banner"]')).not.toBeNull();
  });

  it("switches model and reasoning in local mode while preserving backup chain entries", () => {
    let localConfig: ClientConfig = {
      ...DEFAULT_CONFIG,
      chatChain: [
        { id: "main", provider: "gemini", model: "gemini-4-hydrogen", keySource: "env" },
        { id: "backup", provider: "openrouter", model: "openrouter/free", keySource: "ui", hasSavedKey: true }
      ]
    };

    const updateConfig = vi.fn((patch: Partial<ClientConfig> | ((prev: ClientConfig) => ClientConfig)) => {
      localConfig = typeof patch === "function" ? patch(localConfig) : { ...localConfig, ...patch };
    });

    root = createRoot(container!);
    act(() => {
      root!.render(
        <ModelPicker
          config={localConfig}
          activeSelection={resolveActiveSelection(localConfig, "older-model", { isHosted: false })}
          streaming={true}
          updateConfig={updateConfig}
          defaultOpen
          isHostedOverride={false}
          initialCredentials={{ llm: { gemini: true }, search: {} }}
          initialDiscoveredByProvider={{
            gemini: [
              { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
              { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" }
            ],
            openrouter: [{ id: "openrouter/free", name: "OpenRouter Free" }]
          }}
        />
      );
    });

    expect(document.body.textContent).toContain("Applies from next message");

    const highBtn = document.body.querySelector('[data-testid="picker-reasoning-high"]') as HTMLButtonElement;
    expect(highBtn).not.toBeNull();
    act(() => {
      highBtn.click();
    });

    expect(localConfig.chatChain).toHaveLength(2);
    expect(localConfig.chatChain[0].reasoningEffort).toBe("high");
    expect(localConfig.chatChain[1].id).toBe("backup");

    const switchBtn = document.body.querySelector('[data-testid="picker-model-gemini-gemini-2.5-flash"]') as HTMLButtonElement;
    expect(switchBtn).not.toBeNull();
    act(() => {
      switchBtn.click();
    });

    expect(localConfig.chatChain).toHaveLength(2);
    expect(localConfig.chatChain[0].model).toBe("gemini-2.5-flash");
    expect(localConfig.chatChain[1]).toEqual({
      id: "backup",
      provider: "openrouter",
      model: "openrouter/free",
      keySource: "ui",
      hasSavedKey: true
    });
  });

  it("switches model and reasoning in hosted mode and updates BYOK store", () => {
    setByokKey("gemini", "AIzaSyHostedKey123");
    setByokKey("openrouter", "sk-or-v1-HostedKey123");
    setByokModel("gemini", "gemini-4-hydrogen");
    setActiveByokProvider("gemini");

    const onByokSelectionChange = vi.fn();
    root = createRoot(container!);
    act(() => {
      root!.render(
        <ModelPicker
          config={DEFAULT_CONFIG}
          activeSelection={{ provider: "gemini", model: "gemini-4-hydrogen" }}
          streaming={false}
          updateConfig={vi.fn()}
          onByokSelectionChange={onByokSelectionChange}
          defaultOpen
          isHostedOverride
          initialDiscoveredByProvider={{
            gemini: [{ id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" }],
            openrouter: [{ id: "openrouter/free", name: "OpenRouter Free" }]
          }}
        />
      );
    });

    const mediumBtn = document.body.querySelector('[data-testid="picker-reasoning-medium"]') as HTMLButtonElement;
    act(() => {
      mediumBtn.click();
    });
    expect(getByokReasoningEffort("gemini")).toBe("medium");
    expect(onByokSelectionChange).toHaveBeenCalled();

    const orBtn = document.body.querySelector('[data-testid="picker-model-openrouter-openrouter/free"]') as HTMLButtonElement;
    act(() => {
      orBtn.click();
    });
    expect(getActiveByokProvider()).toBe("openrouter");
    expect(getByokModel("openrouter")).toBe("openrouter/free");
  });
});
