import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider } from "@/components/app/app-provider";
import { SearchableModelSelect } from "@/components/ui/searchable-model-select";
import { Composer, hostedSendBlocked } from "@/features/chat/composer";
import { ByokSection } from "@/features/settings/byok-section";
import { StepLLM, researchDefaultForSearch } from "@/features/wizard/step-llm";
import {
  hostedByokCanAdvance,
  hostedProbeIsCurrent,
  isHostedByokProvider,
  shouldSkipMarketStep
} from "@/features/wizard/hosted-gating";
import { discoverModels } from "@/lib/llm/discovery";
import { hostedDefaultModelFor, HOSTED_LAST_RESORT_MODEL } from "@/lib/llm/hosted-defaults";
import { groupModelsForPicker, isFreeModel, isToolCapableModel, pickFreeToolCapableDefault } from "@/lib/llm/model-recommend";
import { resetCachedDeploymentMode, setCachedDeploymentMode } from "@/lib/api-client";
import {
  resetByokStoreForTesting,
  setByokKey,
  setByokStorageForTesting
} from "@/lib/llm/client-byok-store";
import {
  resolveActiveModel,
  resolveChatRequestBody
} from "@/features/chat/chat-config-resolver";
import type { ClientConfig } from "@/types/client";

class MockStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number { return this.store.size; }
  clear(): void { this.store.clear(); }
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.store.keys())[index] ?? null; }
  removeItem(key: string): void { this.store.delete(key); }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
}

const BANNED_DEFAULT = "anthropic/claude-3.5-sonnet";

function baseConfig(): ClientConfig {
  return {
    onboarded: false,
    theme: "sage-dark",
    countryCode: "IN",
    currency: "INR",
    personality: "default",
    tier2Enabled: true,
    auditVisible: true,
    freeformConsultEnabled: true,
    chatChain: [],
    subagentChain: null,
    searchProvider: "none",
    crawlEnabled: false
  };
}

describe("Track W: hosted BYOK probe gate", () => {
  it("blocks advance without a probe, on reachability alone, or on tools alone", () => {
    expect(hostedByokCanAdvance(null)).toBe(false);
    expect(hostedByokCanAdvance(undefined)).toBe(false);
    expect(hostedByokCanAdvance({ reachable: false, latencyMs: 1, toolCapable: false })).toBe(false);
    expect(hostedByokCanAdvance({ reachable: true, latencyMs: 1, toolCapable: false })).toBe(false);
    expect(hostedByokCanAdvance({ reachable: false, latencyMs: 1, toolCapable: true })).toBe(false);
  });

  it("advances only when reachable AND tool-capable", () => {
    expect(hostedByokCanAdvance({ reachable: true, latencyMs: 12, toolCapable: true })).toBe(true);
  });

  it("rejects a stale probe when provider/model changed after probing", () => {
    const probe = { reachable: true, latencyMs: 5, toolCapable: true };
    expect(
      hostedProbeIsCurrent(probe, { provider: "openrouter", model: "a" }, { provider: "openrouter", model: "b" })
    ).toBe(false);
    expect(
      hostedProbeIsCurrent(probe, { provider: "gemini", model: "a" }, { provider: "openrouter", model: "a" })
    ).toBe(false);
    expect(
      hostedProbeIsCurrent(probe, { provider: "openrouter", model: "a" }, { provider: "openrouter", model: "a" })
    ).toBe(true);
    expect(hostedProbeIsCurrent(null, null, null)).toBe(false);
  });

  it("only treats gemini/groq/openrouter as hosted BYOK providers", () => {
    expect(isHostedByokProvider("gemini")).toBe(true);
    expect(isHostedByokProvider("openrouter")).toBe(true);
    expect(isHostedByokProvider("ollama")).toBe(false);
    expect(isHostedByokProvider("openai-compatible")).toBe(false);
  });
});

describe("Track W: no paid/outdated hosted default", () => {
  it("last-resort hosted default is free and not Claude", () => {
    expect(HOSTED_LAST_RESORT_MODEL).not.toContain("claude");
    expect(HOSTED_LAST_RESORT_MODEL).toMatch(/:free$/);
    expect(hostedDefaultModelFor("openrouter")).toBe(HOSTED_LAST_RESORT_MODEL);
    expect(hostedDefaultModelFor("gemini")).not.toContain("claude");
    expect(hostedDefaultModelFor("groq")).not.toContain("claude");
  });

  it("BYOK picker markup contains no Claude default", () => {
    const markup = renderToStaticMarkup(<ByokSection />);
    expect(markup).not.toContain(BANNED_DEFAULT);
  });

  it("hosted resolver never falls back to the Claude default", () => {
    const config = baseConfig();
    const body = resolveChatRequestBody(config, "s1", {
      isHosted: true,
      activeByokProvider: "openrouter",
      hasKey: () => true,
      getModel: () => undefined,
      getReasoningEffort: () => undefined
    });
    expect(body.config.chatLlmChain[0].model).toBe(HOSTED_LAST_RESORT_MODEL);
    expect(body.config.chatLlmChain[0].model).not.toBe(BANNED_DEFAULT);
    expect(resolveActiveModel(config, undefined, {
      isHosted: true,
      activeByokProvider: "openrouter",
      hasKey: () => true,
      getModel: () => undefined
    })).not.toBe(BANNED_DEFAULT);
  });
});

describe("Track W: discovery metadata drives recommendations", () => {
  const openrouterPayload = {
    data: [
      {
        id: "paid/no-tools",
        name: "Paid No Tools",
        context_length: 8000,
        supported_parameters: ["temperature", "max_tokens"],
        pricing: { prompt: "0.001", completion: "0.002" }
      },
      {
        id: "paid/tools",
        name: "Paid Tools",
        context_length: 32000,
        supported_parameters: ["temperature", "tools", "tool_choice"],
        pricing: { prompt: "0.001", completion: "0.002" }
      },
      {
        id: "free/tools",
        name: "Free Tools",
        context_length: 64000,
        supported_parameters: ["tools"],
        pricing: { prompt: "0", completion: "0" }
      }
    ]
  };

  function mockFetch(payload: unknown): typeof fetch {
    return (async () => ({ ok: true, json: async () => payload })) as unknown as typeof fetch;
  }

  it("parses OpenRouter supported_parameters + pricing into tool/free flags", async () => {
    const models = await discoverModels(
      { provider: "openrouter", model: "__model_discovery__", keySource: "none" } as never,
      mockFetch(openrouterPayload)
    );
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId["free/tools"].toolCapable).toBe(true);
    expect(byId["free/tools"].free).toBe(true);
    expect(byId["paid/tools"].toolCapable).toBe(true);
    expect(byId["paid/tools"].free).toBe(false);
    expect(byId["paid/no-tools"].toolCapable).toBe(false);
    expect(isToolCapableModel(byId["free/tools"])).toBe(true);
    expect(isFreeModel(byId["free/tools"])).toBe(true);
    expect(isFreeModel(byId["paid/tools"])).toBe(false);
  });

  it("preselects the free tool-capable model from discovery, never a hard-coded ID", async () => {
    const models = await discoverModels(
      { provider: "openrouter", model: "__model_discovery__", keySource: "none" } as never,
      mockFetch(openrouterPayload)
    );
    expect(pickFreeToolCapableDefault(models)?.id).toBe("free/tools");
    expect(pickFreeToolCapableDefault([])).toBeUndefined();
    // Discovery failure path: no recommendation → caller must ask the user.
    const noMeta = [{ id: "gemini-2.5-flash" }];
    expect(pickFreeToolCapableDefault(noMeta)).toBeUndefined();
  });

  it("groups tool-capable (free first) into Recommended, rest below", () => {
    const models = [
      { id: "paid/no-tools" },
      { id: "paid/tools", supportedParameters: ["tools"], pricing: { prompt: "1", completion: "1" } },
      { id: "free/tools", supportedParameters: ["TOOLS"], pricing: { prompt: "0", completion: "0" } }
    ];
    const { recommended, rest } = groupModelsForPicker(models);
    expect(recommended.map((m) => m.id)).toEqual(["free/tools", "paid/tools"]);
    expect(rest.map((m) => m.id)).toEqual(["paid/no-tools"]);
    // No tool metadata (local servers, Gemini/Groq) → list renders as today.
    expect(groupModelsForPicker([{ id: "a" }, { id: "b" }]).recommended).toEqual([]);
  });

  it("picker shows a Recommended group with Free marks", () => {
    const markup = renderToStaticMarkup(
      <SearchableModelSelect
        value="free/tools"
        onChange={vi.fn()}
        models={[
          { id: "paid/no-tools", name: "Paid No Tools" },
          { id: "paid/tools", name: "Paid Tools", toolCapable: true },
          { id: "free/tools", name: "Free Tools", toolCapable: true, free: true }
        ]}
        providerId="openrouter"
        defaultOpen
      />
    );
    expect(markup).toContain("Recommended");
    expect(markup).toContain("Free");
    expect(markup).toContain("All models");
  });

  it("picker without tool metadata renders flat with no Recommended group", () => {
    const markup = renderToStaticMarkup(
      <SearchableModelSelect
        value="llama3"
        onChange={vi.fn()}
        models={[{ id: "llama3" }, { id: "mistral" }]}
        defaultOpen
      />
    );
    expect(markup).not.toContain("Recommended");
  });
});

describe("Track W: disabled reasons next to Continue", () => {
  function renderStep(canAdvance: boolean): string {
    return renderToStaticMarkup(
      <AppProvider>
        <StepLLM
          chain={[{ id: "e1", provider: "ollama", model: "llama3", keySource: "none" }]}
          onChange={vi.fn()}
          credentials={null}
          endpointState={{ status: "ready", endpoints: [] }}
          onRetryEndpoints={vi.fn()}
          onBack={vi.fn()}
          onNext={vi.fn()}
          canAdvance={canAdvance}
        />
      </AppProvider>
    );
  }

  it("local step shows why Continue is disabled", () => {
    const blocked = renderStep(false);
    expect(blocked).toContain("llm-continue-reason");
    expect(blocked).toContain("Ping");
    expect(blocked).toContain("reachable and support tool calling");
    expect(blocked).toContain("disabled");
    expect(renderStep(true)).not.toContain("llm-continue-reason");
  });
});

describe("Track W: hosted missing-key prompt blocks sending", () => {
  let session: MockStorage;
  let local: MockStorage;

  beforeEach(() => {
    session = new MockStorage();
    local = new MockStorage();
    resetCachedDeploymentMode();
    resetByokStoreForTesting();
    setByokStorageForTesting(session, local);
  });

  function renderComposer(): string {
    return renderToStaticMarkup(
      <Composer onSend={vi.fn()} onStop={vi.fn()} streaming={false} />
    );
  }

  it("shows the inline prompt and disables send with no key in hosted mode", () => {
    setCachedDeploymentMode("hosted-demo");
    const markup = renderComposer();
    expect(markup).toContain("byok-missing-prompt");
    expect(markup).toContain("Add your API key to continue");
    expect(markup).toContain("/settings?tab=llm");
    expect(markup).toContain("disabled");
  });

  it("does not block once a key exists", () => {
    setCachedDeploymentMode("hosted-demo");
    setByokKey("gemini", "test-key", false);
    expect(hostedSendBlocked()).toBe(false);
    expect(renderComposer()).not.toContain("byok-missing-prompt");
  });

  it("blocks only when no provider the chat could fall back to has a key", () => {
    setCachedDeploymentMode("hosted-demo");
    expect(hostedSendBlocked({ activeProvider: "groq", storedProviders: [], hasKey: () => false })).toBe(true);
    expect(hostedSendBlocked({ activeProvider: "groq", storedProviders: [], hasKey: () => true })).toBe(false);
    // The active provider lost its key but Gemini still has one: the resolver
    // sends the chat to Gemini, so the composer must not block it.
    expect(
      hostedSendBlocked({ activeProvider: "openrouter", storedProviders: [], hasKey: (p) => p === "gemini" })
    ).toBe(false);
  });

  it("never blocks in local mode", () => {
    setCachedDeploymentMode("local");
    expect(hostedSendBlocked()).toBe(false);
    expect(renderComposer()).not.toContain("byok-missing-prompt");
  });
});

describe("Track W: single-market skip", () => {
  it("skips only when exactly one market exists", () => {
    expect(shouldSkipMarketStep([{ code: "IN" }])).toBe(true);
    expect(shouldSkipMarketStep([])).toBe(false);
    expect(shouldSkipMarketStep([{ code: "IN" }, { code: "US" }])).toBe(false);
    expect(shouldSkipMarketStep(null)).toBe(false);
    expect(shouldSkipMarketStep(undefined)).toBe(false);
  });
});

describe("Track W: research default follows search availability", () => {
  it("stays off with a one-line reason when no search provider is configured", () => {
    const result = researchDefaultForSearch("none", null);
    expect(result.enabled).toBe(false);
    expect(result.reason).toMatch(/no search provider/i);
  });

  it("stays off with a reason when the search probe failed", () => {
    const result = researchDefaultForSearch("tavily", false);
    expect(result.enabled).toBe(false);
    expect(result.reason).toMatch(/probe failed/i);
  });

  it("turns on only when search is configured and the probe succeeds", () => {
    expect(researchDefaultForSearch("tavily", true)).toEqual({ enabled: true, reason: null });
    expect(researchDefaultForSearch("brave", null).enabled).toBe(false);
  });
});
