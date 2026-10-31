"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchModels } from "@/lib/api-client";
import { pickFreeToolCapableDefault } from "@/lib/llm/model-recommend";
import type { DiscoveredModel, ReasoningEffort } from "@/types/client";
import {
  clearByokKey,
  clearByokModel,
  clearByokReasoningEffort,
  getActiveByokProvider,
  getByokKey,
  getByokModel,
  getByokReasoningEffort,
  isByokKeyPersistent,
  setActiveByokProvider,
  setByokKey,
  setByokModel,
  setByokReasoningEffort
} from "@/lib/llm/client-byok-store";
import { Button } from "@/components/ui/primitives";
import { PillTabs } from "@/components/ui/pill-tabs";
import { ByokProviderCard, type ProviderConfig } from "./byok-provider-card";
import { KeyHandlingNote, KeyHelpPanel } from "./key-help-panel";

const BYOK_PROVIDERS: ProviderConfig[] = [
  {
    id: "gemini",
    name: "Google Gemini",
    placeholder: "AIzaSy...",
    defaultModel: "gemini-2.5-flash",
    docsUrl: "https://aistudio.google.com/app/apikey",
    docsLabel: "Get a Gemini key"
  },
  {
    id: "groq",
    name: "Groq",
    placeholder: "gsk_...",
    defaultModel: "llama-3.3-70b-versatile",
    docsUrl: "https://console.groq.com/keys",
    docsLabel: "Get a Groq key"
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    placeholder: "sk-or-v1-...",
    // No paid default: the model is preselected from live discovery (free +
    // tool-capable) once a key is saved, otherwise the user picks.
    defaultModel: "",
    docsUrl: "https://openrouter.ai/keys",
    docsLabel: "Get an OpenRouter key"
  }
];

/**
 * "settings" lists every provider's key row under a heading and the free-key
 * steps. "onboarding" sits under the step's own title and shows one provider
 * at a time behind tabs, so a first-time visitor sees a single key field.
 */
export function ByokSection({
  className,
  variant = "settings",
  onKeyChange,
  onModelChange
}: {
  className?: string;
  variant?: "settings" | "onboarding";
  onKeyChange?: (provider: string, hasKey: boolean) => void;
  onModelChange?: (provider: string, model: string, contextLimit?: number) => void;
}) {
  const [keys, setKeys] = useState<Record<string, string | undefined>>(() => ({
    gemini: getByokKey("gemini"),
    groq: getByokKey("groq"),
    openrouter: getByokKey("openrouter")
  }));

  const [drafts, setDrafts] = useState<Record<string, string>>({
    gemini: "",
    groq: "",
    openrouter: ""
  });

  const [persists, setPersists] = useState<Record<string, boolean>>(() => ({
    gemini: isByokKeyPersistent("gemini"),
    groq: isByokKeyPersistent("groq"),
    openrouter: isByokKeyPersistent("openrouter")
  }));

  const [editing, setEditing] = useState<Record<string, boolean>>({
    gemini: false,
    groq: false,
    openrouter: false
  });

  const [showDraft, setShowDraft] = useState<Record<string, boolean>>({
    gemini: false,
    groq: false,
    openrouter: false
  });

  const [selectedModels, setSelectedModels] = useState<Record<string, string>>(() => ({
    gemini: getByokModel("gemini") || "gemini-2.5-flash",
    groq: getByokModel("groq") || "llama-3.3-70b-versatile",
    // OpenRouter has no default: preselected from discovery (free +
    // tool-capable) once a key exists, otherwise the user picks.
    openrouter: getByokModel("openrouter") || ""
  }));

  const [reasoningEfforts, setReasoningEfforts] = useState<Record<string, ReasoningEffort | undefined>>(() => ({
    gemini: getByokReasoningEffort("gemini"),
    groq: getByokReasoningEffort("groq"),
    openrouter: getByokReasoningEffort("openrouter")
  }));

  const [models, setModels] = useState<Record<string, DiscoveredModel[]>>({});
  const [loadingModels, setLoadingModels] = useState<Record<string, boolean>>({});
  const [modelErrors, setModelErrors] = useState<Record<string, string | undefined>>({});
  const [customInputs, setCustomInputs] = useState<Record<string, boolean>>({
    gemini: false,
    groq: false,
    openrouter: false
  });
  const [customDrafts, setCustomDrafts] = useState<Record<string, string>>({
    gemini: "",
    groq: "",
    openrouter: ""
  });

  const [activeProvider, setActiveProviderState] = useState<string | null>(() => getActiveByokProvider() ?? null);
  const onboarding = variant === "onboarding";
  const [shownProvider, setShownProvider] = useState<string>(() => getActiveByokProvider() ?? BYOK_PROVIDERS[0].id);

  // Models the user explicitly picked — auto-preselect never overrides these.
  const userPickedRef = useRef<Record<string, boolean>>({});
  const onModelChangeRef = useRef(onModelChange);
  useEffect(() => {
    onModelChangeRef.current = onModelChange;
  });

  const loadModelsForProvider = useCallback(
    async (providerId: "gemini" | "openrouter" | "groq", apiKey?: string, forceRefresh = false) => {
      const keyToUse = apiKey ?? keys[providerId];
      if (!keyToUse) return;

      if (!forceRefresh && models[providerId] && models[providerId].length > 0) return;

      setLoadingModels((prev) => ({ ...prev, [providerId]: true }));
      setModelErrors((prev) => ({ ...prev, [providerId]: undefined }));

      try {
        const discovered = await fetchModels({
          provider: providerId,
          apiKey: keyToUse,
          keySource: "ui"
        });
        if (discovered && discovered.length > 0) {
          setModels((prev) => ({ ...prev, [providerId]: discovered }));
        } else {
          setModelErrors((prev) => ({
            ...prev,
            [providerId]: "No models returned from provider API."
          }));
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setModelErrors((prev) => ({
          ...prev,
          [providerId]: message
        }));
      } finally {
        setLoadingModels((prev) => ({ ...prev, [providerId]: false }));
      }
    },
    [keys, models]
  );

  useEffect(() => {
    for (const p of BYOK_PROVIDERS) {
      if (keys[p.id] && !models[p.id]?.length && !loadingModels[p.id]) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- async model fetch triggered when keys are available
        void loadModelsForProvider(p.id, keys[p.id], false);
      }
    }
  }, [keys, models, loadingModels, loadModelsForProvider]);

  // Preselect a free, tool-capable model from live discovery when the user
  // has not picked one. Falls back to asking the user (no hard-coded IDs).
  useEffect(() => {
    for (const p of BYOK_PROVIDERS) {
      const discovered = models[p.id];
      if (!discovered || discovered.length === 0) continue;
      if (userPickedRef.current[p.id]) continue;
      const current = selectedModels[p.id];
      if (current && discovered.some((m) => m.id === current)) continue;
      const pick = pickFreeToolCapableDefault(discovered);
      if (pick && pick.id !== current) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-way preselect from async discovery
        setSelectedModels((prev) => ({ ...prev, [p.id]: pick.id }));
        setByokModel(p.id, pick.id, persists[p.id]);
        // Only the provider the chat will use drives the chain; a background
        // provider finishing discovery must not switch the user's chat to it.
        const active = getActiveByokProvider();
        if (!active || active === p.id) onModelChangeRef.current?.(p.id, pick.id, pick.contextLimit);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-way preselect; selectedModels/persists read intentionally
  }, [models]);

  const handleSave = (provider: "gemini" | "openrouter" | "groq") => {
    const raw = drafts[provider]?.trim();
    if (!raw) return;

    setByokKey(provider, raw, persists[provider]);
    const stored = getByokKey(provider);
    setKeys((prev) => ({ ...prev, [provider]: stored }));
    setDrafts((prev) => ({ ...prev, [provider]: "" }));
    setEditing((prev) => ({ ...prev, [provider]: false }));
    setActiveByokProvider(provider, persists[provider]);
    setActiveProviderState(provider);
    onKeyChange?.(provider, true);
    const activeModel =
      selectedModels[provider] ||
      (provider === "gemini"
        ? "gemini-2.5-flash"
        : provider === "groq"
          ? "llama-3.3-70b-versatile"
          : "");
    if (activeModel) {
      const matched = models[provider]?.find((m) => m.id === activeModel);
      onModelChange?.(provider, activeModel, matched?.contextLimit);
    }

    void loadModelsForProvider(provider, raw, true);
  };

  const handleClear = (provider: "gemini" | "openrouter" | "groq") => {
    clearByokKey(provider);
    clearByokModel(provider);
    clearByokReasoningEffort(provider);
    setKeys((prev) => ({ ...prev, [provider]: undefined }));
    setDrafts((prev) => ({ ...prev, [provider]: "" }));
    setEditing((prev) => ({ ...prev, [provider]: false }));
    setModels((prev) => ({ ...prev, [provider]: [] }));
    setModelErrors((prev) => ({ ...prev, [provider]: undefined }));
    setReasoningEfforts((prev) => ({ ...prev, [provider]: undefined }));
    onKeyChange?.(provider, false);
  };

  const handleReasoningEffortChange = (providerId: "gemini" | "openrouter" | "groq", effort?: ReasoningEffort) => {
    setReasoningEfforts((prev) => ({ ...prev, [providerId]: effort }));
    setByokReasoningEffort(providerId, effort, persists[providerId]);
  };

  const handleModelChange = (providerId: "gemini" | "openrouter" | "groq", modelId: string) => {
    const trimmed = modelId.trim();
    if (!trimmed) return;
    userPickedRef.current[providerId] = true;
    setSelectedModels((prev) => ({ ...prev, [providerId]: trimmed }));
    setByokModel(providerId, trimmed, persists[providerId]);
    setActiveByokProvider(providerId, persists[providerId]);
    setActiveProviderState(providerId);
    setCustomInputs((prev) => ({ ...prev, [providerId]: false }));
    const matched = models[providerId]?.find((m) => m.id === trimmed);
    onModelChange?.(providerId, trimmed, matched?.contextLimit);
  };

  const handleActiveProviderChange = (providerId: "gemini" | "openrouter" | "groq") => {
    setActiveProviderState(providerId);
    setActiveByokProvider(providerId, persists[providerId]);
    const activeModel = selectedModels[providerId];
    if (activeModel) {
      const matched = models[providerId]?.find((m) => m.id === activeModel);
      onModelChange?.(providerId, activeModel, matched?.contextLimit);
    }
  };

  const configuredProviders = BYOK_PROVIDERS.filter((p) => Boolean(keys[p.id]));
  const shownProviders = onboarding ? BYOK_PROVIDERS.filter((p) => p.id === shownProvider) : BYOK_PROVIDERS;

  // Onboarding: the chat follows the tab on screen once that provider has a key.
  const showProvider = (providerId: string) => {
    setShownProvider(providerId);
    const provider = BYOK_PROVIDERS.find((p) => p.id === providerId);
    if (provider && keys[provider.id]) handleActiveProviderChange(provider.id);
  };

  return (
    <section className={`flex flex-col gap-5 ${className ?? ""}`} data-testid="byok-section">
      {!onboarding ? (
        <div className="flex flex-col gap-1">
          <h2 className="type-title text-xl text-text">AI model</h2>
          <p className="text-sm text-text-secondary">
            Add your own key for Google Gemini, Groq or OpenRouter, then pick the model that answers your chats.
          </p>
        </div>
      ) : null}

      {!onboarding ? <KeyHelpPanel /> : null}

      {!onboarding && configuredProviders.length > 1 && (
        <div
          className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4"
          data-testid="byok-active-provider-card"
        >
          <div className="flex flex-col gap-0.5">
            <h3 className="type-title text-base text-text">Chat uses</h3>
            <p className="text-caption text-text-secondary">New chats use this provider and its model.</p>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
            {configuredProviders.map((p) => (
              <Button
                key={p.id}
                variant={activeProvider === p.id ? "primary" : "ghost"}
                size="sm"
                onClick={() => handleActiveProviderChange(p.id)}
                data-testid={`byok-active-${p.id}`}
                className="min-w-0 justify-start"
              >
                <span className="truncate">
                  {p.name}
                  {selectedModels[p.id] ? <span className="font-mono"> {selectedModels[p.id]}</span> : null}
                </span>
              </Button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {onboarding ? (
          <div className="self-start">
            <PillTabs
              tabs={BYOK_PROVIDERS.map((p) => ({ value: p.id, label: p.name }))}
              value={shownProvider}
              onChange={showProvider}
              ariaLabel="AI provider"
            />
          </div>
        ) : (
          <h3 className="type-title text-base text-text">Your API keys</h3>
        )}
        <div className="divide-y divide-border rounded-card border border-border bg-surface">
          {shownProviders.map((provider) => (
            <ByokProviderCard
              key={provider.id}
              provider={provider}
              currentKey={keys[provider.id]}
              draft={drafts[provider.id] || ""}
              onDraftChange={(val) => setDrafts((prev) => ({ ...prev, [provider.id]: val }))}
              persist={persists[provider.id]}
              onPersistChange={(val) => setPersists((prev) => ({ ...prev, [provider.id]: val }))}
              isEditing={editing[provider.id]}
              onSetEditing={(val) => setEditing((prev) => ({ ...prev, [provider.id]: val }))}
              showDraft={showDraft[provider.id]}
              onToggleShowDraft={() => setShowDraft((prev) => ({ ...prev, [provider.id]: !prev[provider.id] }))}
              selectedModel={selectedModels[provider.id]}
              onModelChange={(model) => handleModelChange(provider.id, model)}
              models={models[provider.id]}
              loadingModels={loadingModels[provider.id]}
              modelError={modelErrors[provider.id]}
              customInput={customInputs[provider.id]}
              onSetCustomInput={(val) => setCustomInputs((prev) => ({ ...prev, [provider.id]: val }))}
              customDraft={customDrafts[provider.id]}
              onCustomDraftChange={(val) => setCustomDrafts((prev) => ({ ...prev, [provider.id]: val }))}
              reasoningEffort={reasoningEfforts[provider.id]}
              onReasoningEffortChange={(effort) => handleReasoningEffortChange(provider.id, effort)}
              onSave={() => handleSave(provider.id)}
              onClear={() => handleClear(provider.id)}
              onDetectModels={() => void loadModelsForProvider(provider.id, keys[provider.id], true)}
            />
          ))}
        </div>
        <KeyHandlingNote />
      </div>
    </section>
  );
}
