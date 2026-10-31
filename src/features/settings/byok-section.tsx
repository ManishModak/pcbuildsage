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
import { Check } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icon";
import { Button, ChoiceControl, ChoiceGroup } from "@/components/ui/primitives";
import { ByokProviderCard, type ProviderConfig } from "./byok-provider-card";
import { KeyHandlingNote, KeyHelpPanel } from "./key-help-panel";

// Every per-provider list below is built from this one, so a new provider is
// one entry here (plus its server adapter).
const BYOK_PROVIDERS: ProviderConfig[] = [
  {
    id: "gemini",
    name: "Google Gemini",
    note: "Free key from Google AI Studio",
    placeholder: "AIzaSy...",
    defaultModel: "gemini-2.5-flash",
    docsUrl: "https://aistudio.google.com/app/apikey",
    docsLabel: "Get a Gemini key"
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    note: "One key for models from OpenAI, Anthropic, DeepSeek and others, free and paid",
    placeholder: "sk-or-v1-...",
    // No paid default: the model is preselected from live discovery (free +
    // tool-capable) once a key is saved, otherwise the user picks.
    defaultModel: "",
    docsUrl: "https://openrouter.ai/keys",
    docsLabel: "Get an OpenRouter key"
  },
  {
    id: "groq",
    name: "Groq",
    note: "Free key, fast open models",
    placeholder: "gsk_...",
    defaultModel: "llama-3.3-70b-versatile",
    docsUrl: "https://console.groq.com/keys",
    docsLabel: "Get a Groq key"
  }
];

type ProviderId = ProviderConfig["id"];

function perProvider<T>(value: (provider: ProviderConfig) => T): Record<string, T> {
  return Object.fromEntries(BYOK_PROVIDERS.map((provider) => [provider.id, value(provider)]));
}

/**
 * "settings" lists every provider's key row under a heading and the free-key
 * steps. "onboarding" sits under the step's own title: a list of providers to
 * pick from, then the picked one's key field, so a first-time visitor sees a
 * single key field however many providers there are.
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
  const [keys, setKeys] = useState(() => perProvider<string | undefined>((p) => getByokKey(p.id)));
  const [drafts, setDrafts] = useState(() => perProvider(() => ""));
  const [persists, setPersists] = useState(() => perProvider((p) => isByokKeyPersistent(p.id)));
  const [editing, setEditing] = useState(() => perProvider(() => false));
  const [showDraft, setShowDraft] = useState(() => perProvider(() => false));
  const [selectedModels, setSelectedModels] = useState(() => perProvider((p) => getByokModel(p.id) || p.defaultModel));
  const [reasoningEfforts, setReasoningEfforts] = useState(() =>
    perProvider<ReasoningEffort | undefined>((p) => getByokReasoningEffort(p.id))
  );

  const [models, setModels] = useState<Record<string, DiscoveredModel[]>>({});
  const [loadingModels, setLoadingModels] = useState<Record<string, boolean>>({});
  const [modelErrors, setModelErrors] = useState<Record<string, string | undefined>>({});
  const [customInputs, setCustomInputs] = useState(() => perProvider(() => false));
  const [customDrafts, setCustomDrafts] = useState(() => perProvider(() => ""));

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
    async (providerId: ProviderId, apiKey?: string, forceRefresh = false) => {
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

  // Load each keyed provider's models once. A failed load waits for Save or
  // the refresh button: retrying here would loop on a bad key.
  useEffect(() => {
    for (const p of BYOK_PROVIDERS) {
      if (keys[p.id] && !models[p.id]?.length && !loadingModels[p.id] && !modelErrors[p.id]) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- async model fetch triggered when keys are available
        void loadModelsForProvider(p.id, keys[p.id], false);
      }
    }
  }, [keys, models, loadingModels, modelErrors, loadModelsForProvider]);

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

  const handleSave = (provider: ProviderId) => {
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
    const activeModel = selectedModels[provider] || BYOK_PROVIDERS.find((p) => p.id === provider)?.defaultModel;
    if (activeModel) {
      const matched = models[provider]?.find((m) => m.id === activeModel);
      onModelChange?.(provider, activeModel, matched?.contextLimit);
    }

    void loadModelsForProvider(provider, raw, true);
  };

  const handleClear = (provider: ProviderId) => {
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

  const handleReasoningEffortChange = (providerId: ProviderId, effort?: ReasoningEffort) => {
    setReasoningEfforts((prev) => ({ ...prev, [providerId]: effort }));
    setByokReasoningEffort(providerId, effort, persists[providerId]);
  };

  const handleModelChange = (providerId: ProviderId, modelId: string) => {
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

  const handleActiveProviderChange = (providerId: ProviderId) => {
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

  // Onboarding: the step checks the tab on screen, so every switch moves the
  // chat to it, even before that provider has a key or a model.
  const showProvider = (providerId: string) => {
    setShownProvider(providerId);
    setActiveProviderState(providerId);
    setActiveByokProvider(providerId, persists[providerId]);
    const model = selectedModels[providerId] ?? "";
    onModelChange?.(providerId, model, models[providerId]?.find((m) => m.id === model)?.contextLimit);
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
          <ChoiceGroup label="AI provider" legendClassName="sr-only">
            <div className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
              {BYOK_PROVIDERS.map((provider) => {
                const selected = provider.id === shownProvider;
                return (
                  <ChoiceControl
                    key={provider.id}
                    type="radio"
                    name="byok-provider"
                    value={provider.id}
                    checked={selected}
                    onChange={() => showProvider(provider.id)}
                    className={cn(
                      "flex items-start gap-3 px-4 py-3 text-left transition-colors duration-150",
                      selected ? "bg-surface-raised" : "hover:bg-surface-raised"
                    )}
                  >
                    {selected ? <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-accent" /> : null}
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-x-4">
                      <span className="text-[15px] font-medium text-text">{provider.name}</span>
                      <span className="text-caption text-text-secondary sm:text-right">{provider.note}</span>
                    </span>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-pill border",
                        selected ? "border-accent bg-accent text-on-accent" : "border-border"
                      )}
                    >
                      {selected ? <Icon icon={Check} size={12} /> : null}
                    </span>
                  </ChoiceControl>
                );
              })}
            </div>
          </ChoiceGroup>
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
