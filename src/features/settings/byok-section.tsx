"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { fetchModels } from "@/lib/api-client";
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
import { Button, Card } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/icon";
import { ByokProviderCard, type ProviderConfig } from "./byok-provider-card";

const BYOK_PROVIDERS: ProviderConfig[] = [
  {
    id: "gemini",
    name: "Google Gemini",
    placeholder: "AIzaSy...",
    defaultModel: "gemini-2.5-flash",
    docsUrl: "https://aistudio.google.com/app/apikey",
    docsLabel: "Get Gemini API Key"
  },
  {
    id: "groq",
    name: "Groq",
    placeholder: "gsk_...",
    defaultModel: "llama-3.3-70b-versatile",
    docsUrl: "https://console.groq.com/keys",
    docsLabel: "Get Groq API Key"
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    placeholder: "sk-or-v1-...",
    defaultModel: "anthropic/claude-3.5-sonnet",
    docsUrl: "https://openrouter.ai/keys",
    docsLabel: "Get OpenRouter API Key"
  }
];

export function ByokSection({
  className,
  onKeyChange,
  onModelChange
}: {
  className?: string;
  onKeyChange?: (provider: string, hasKey: boolean) => void;
  onModelChange?: (provider: string, model: string) => void;
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
    openrouter: getByokModel("openrouter") || "anthropic/claude-3.5-sonnet"
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
          : "anthropic/claude-3.5-sonnet");
    onModelChange?.(provider, activeModel);

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
    setSelectedModels((prev) => ({ ...prev, [providerId]: trimmed }));
    setByokModel(providerId, trimmed, persists[providerId]);
    setActiveByokProvider(providerId, persists[providerId]);
    setActiveProviderState(providerId);
    setCustomInputs((prev) => ({ ...prev, [providerId]: false }));
    onModelChange?.(providerId, trimmed);
  };

  const handleActiveProviderChange = (providerId: "gemini" | "openrouter" | "groq") => {
    setActiveProviderState(providerId);
    setActiveByokProvider(providerId, persists[providerId]);
    const activeModel = selectedModels[providerId];
    if (activeModel) {
      onModelChange?.(providerId, activeModel);
    }
  };

  const configuredProviders = BYOK_PROVIDERS.filter((p) => Boolean(keys[p.id]));

  return (
    <section className={`flex flex-col gap-5 ${className ?? ""}`} data-testid="byok-section">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-lg font-semibold text-text">Bring Your Own Key (BYOK)</h2>
        <p className="text-caption text-text-secondary">
          Enter your own API keys for Google Gemini, Groq, or OpenRouter. Keys are stored safely in browser storage and sent
          exclusively via per-request HTTP headers to guarantee zero server-side storage or logging.
        </p>
      </div>

      {configuredProviders.length > 1 && (
        <Card className="flex flex-col gap-3 p-4 bg-surface-raised border-border" data-testid="byok-active-provider-card">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-text">Active Chat Provider</span>
            <span className="text-caption text-accent font-medium">Auto-selected for new chats</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
            {configuredProviders.map((p) => (
              <Button
                key={p.id}
                variant={activeProvider === p.id ? "primary" : "ghost"}
                size="sm"
                onClick={() => handleActiveProviderChange(p.id)}
                data-testid={`byok-active-${p.id}`}
                className="justify-start truncate"
              >
                {p.name} ({selectedModels[p.id]})
              </Button>
            ))}
          </div>
        </Card>
      )}

      <div className="flex flex-col gap-4">
        {BYOK_PROVIDERS.map((provider) => (
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

        <div className="flex items-start gap-2.5 rounded-btn border border-border bg-surface-raised p-3 text-caption text-text-secondary">
          <Icon icon={ShieldCheck} size={16} className="text-accent mt-0.5 shrink-0" />
          <p className="leading-relaxed">
            <strong className="font-semibold text-text">Security & Privacy Guarantee:</strong> Keys are stored only in your
            browser&apos;s temporary <code className="text-accent">sessionStorage</code> by default and vanish automatically when this
            tab is closed. They are forwarded strictly in encrypted per-request HTTP headers for active inference, and are
            never written to any database, file, or server log.
          </p>
        </div>
      </div>
    </section>
  );
}
