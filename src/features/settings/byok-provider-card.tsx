"use client";

import { Check, Cpu, Eye, EyeOff, Key, Lock, RotateCw, Trash2 } from "lucide-react";
import type { DiscoveredModel } from "@/types/client";
import { maskApiKey } from "@/lib/llm/client-byok-store";
import { Button, Card, Field, Input, Toggle } from "@/components/ui/primitives";
import { SearchableModelSelect } from "@/components/ui/searchable-model-select";
import { Icon } from "@/components/ui/icon";

export interface ProviderConfig {
  id: "gemini" | "openrouter";
  name: string;
  placeholder: string;
  defaultModel: string;
  docsUrl: string;
  docsLabel: string;
}

export interface ByokProviderCardProps {
  provider: ProviderConfig;
  currentKey?: string;
  draft: string;
  onDraftChange: (value: string) => void;
  persist: boolean;
  onPersistChange: (value: boolean) => void;
  isEditing: boolean;
  onSetEditing: (editing: boolean) => void;
  showDraft: boolean;
  onToggleShowDraft: () => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
  models?: DiscoveredModel[];
  loadingModels: boolean;
  modelError?: string;
  customInput: boolean;
  onSetCustomInput: (custom: boolean) => void;
  customDraft: string;
  onCustomDraftChange: (draft: string) => void;
  onSave: () => void;
  onClear: () => void;
  onDetectModels: () => void;
}

export function ByokProviderCard({
  provider,
  currentKey,
  draft,
  onDraftChange,
  persist,
  onPersistChange,
  isEditing,
  onSetEditing,
  showDraft,
  onToggleShowDraft,
  selectedModel,
  onModelChange,
  models,
  loadingModels,
  modelError,
  customInput,
  onSetCustomInput,
  customDraft,
  onCustomDraftChange,
  onSave,
  onClear,
  onDetectModels
}: ByokProviderCardProps) {
  const isConfigured = Boolean(currentKey);

  return (
    <Card className="flex flex-col gap-4 p-4" data-testid={`byok-card-${provider.id}`}>
      <div className="flex items-center justify-between gap-2 border-b border-border pb-3">
        <div className="flex items-center gap-2">
          <Icon icon={Key} size={16} className="text-accent" />
          <span className="text-sm font-semibold text-text">{provider.name}</span>
        </div>
        <div className="flex items-center gap-2">
          {isConfigured ? (
            <span
              className="inline-flex items-center gap-1 rounded-pill bg-accent/10 px-2.5 py-0.5 text-caption font-medium text-accent"
              data-testid={`byok-${provider.id}-status`}
            >
              <Icon icon={Check} size={12} />
              Configured
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-1 rounded-pill bg-surface-raised px-2.5 py-0.5 text-caption font-medium text-text-muted"
              data-testid={`byok-${provider.id}-status`}
            >
              Not Configured
            </span>
          )}
          <a
            href={provider.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-caption text-text-muted hover:text-accent hover:underline hidden sm:inline-block"
          >
            {provider.docsLabel} ↗
          </a>
        </div>
      </div>

      {isConfigured && !isEditing ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <Icon icon={Lock} size={14} className="text-text-muted" />
              <span className="text-caption text-text-muted">API Key:</span>
              <span
                className="font-mono text-sm font-medium text-text bg-surface-raised px-2.5 py-1 rounded-btn border border-border"
                data-testid={`byok-${provider.id}-masked`}
              >
                {maskApiKey(currentKey ?? "")}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onSetEditing(true)}
                data-testid={`byok-${provider.id}-edit`}
              >
                Replace Key
              </Button>
              <Button
                variant="danger"
                size="sm"
                iconLeft={Trash2}
                onClick={onClear}
                data-testid={`byok-${provider.id}-clear`}
              >
                Clear Key
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2.5 pt-3 border-t border-border" data-testid={`byok-${provider.id}-model-section`}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Icon icon={Cpu} size={14} className="text-accent" />
                <span className="text-sm font-medium text-text">Configured Model</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                iconLeft={RotateCw}
                disabled={loadingModels}
                onClick={onDetectModels}
                data-testid={`byok-${provider.id}-detect`}
                className={loadingModels ? "opacity-75" : ""}
              >
                {loadingModels ? "Detecting…" : "Auto-Detect Models"}
              </Button>
            </div>

            {loadingModels ? (
              <div className="flex items-center gap-2 text-caption text-text-secondary bg-surface-raised p-2.5 rounded-btn border border-border">
                <Icon icon={RotateCw} size={14} className="animate-spin text-accent" />
                <span>Connecting to {provider.name} API to auto-detect available models…</span>
              </div>
            ) : customInput ? (
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <Input
                    mono
                    placeholder={`Enter custom ${provider.name} model ID`}
                    value={customDraft || selectedModel}
                    onChange={(e) => onCustomDraftChange(e.target.value)}
                    className="flex-1"
                    data-testid={`byok-${provider.id}-custom-input`}
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!customDraft?.trim()}
                    onClick={() => {
                      const val = customDraft?.trim();
                      if (val) onModelChange(val);
                    }}
                  >
                    Apply
                  </Button>
                  <Button
                    variant="quiet"
                    size="sm"
                    onClick={() => onSetCustomInput(false)}
                  >
                    Cancel
                  </Button>
                </div>
                <span className="text-caption text-text-muted">Type any model slug supported by your account.</span>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <SearchableModelSelect
                  data-testid={`byok-${provider.id}-model-select`}
                  value={selectedModel}
                  onChange={onModelChange}
                  models={
                    models && models.length > 0
                      ? models
                      : [{ id: selectedModel, name: selectedModel }]
                  }
                  providerId={provider.id}
                  placeholder={`Select ${provider.name} model...`}
                />
                {modelError ? (
                  <div className="flex items-center justify-between text-caption text-amber-500 bg-amber-500/10 px-3 py-1.5 rounded-btn">
                    <span>Auto-detection note: {modelError}</span>
                    <button
                      type="button"
                      className="underline font-medium hover:text-amber-400 cursor-pointer"
                      onClick={() => onSetCustomInput(true)}
                    >
                      Custom model
                    </button>
                  </div>
                ) : (
                  <span className="text-caption text-text-muted">
                    {models?.length
                      ? `Auto-detected ${models.length} models from your account.`
                      : `Click "Auto-Detect Models" to fetch live available models from your ${provider.name} account.`}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Field label="API Key" hint="Keys are transmitted only in request headers.">
            {(controlProps) => (
              <div className="relative">
                <Input
                  {...controlProps}
                  mono
                  data-testid={`byok-${provider.id}-input`}
                  type={showDraft ? "text" : "password"}
                  placeholder={provider.placeholder}
                  value={draft}
                  onChange={(e) => onDraftChange(e.target.value)}
                  className="pr-10"
                />
                <button
                  type="button"
                  aria-label={showDraft ? "Hide API key" : "Show API key"}
                  onClick={onToggleShowDraft}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text cursor-pointer"
                >
                  <Icon icon={showDraft ? EyeOff : Eye} size={16} />
                </button>
              </div>
            )}
          </Field>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between pt-1">
            <Toggle
              checked={persist}
              onChange={onPersistChange}
              label="Remember for this browser"
              description="Save in localStorage (default is ephemeral tab sessionStorage)."
            />

            <div className="flex items-center gap-2 self-end sm:self-auto">
              {isConfigured ? (
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => onSetEditing(false)}
                >
                  Cancel
                </Button>
              ) : null}
              <Button
                variant="primary"
                size="sm"
                disabled={!draft.trim()}
                onClick={onSave}
                data-testid={`byok-${provider.id}-save`}
              >
                Save Key
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
