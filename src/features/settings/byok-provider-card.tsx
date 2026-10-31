"use client";

import { Check, ExternalLink, Eye, EyeOff, RotateCw, Trash2 } from "lucide-react";
import type { DiscoveredModel, ReasoningEffort } from "@/types/client";
import { maskApiKey } from "@/lib/llm/client-byok-store";
import { Button, Field, Input, Spinner, Toggle } from "@/components/ui/primitives";
import { SearchableModelSelect } from "@/components/ui/searchable-model-select";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/components/ui/cn";

/** One provider row inside the "Your API keys" group (see byok-section.tsx). */
export interface ProviderConfig {
  id: "gemini" | "openrouter" | "groq";
  /** One line shown beside the name where the provider is picked. */
  note: string;
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
  reasoningEffort?: ReasoningEffort;
  onReasoningEffortChange?: (effort?: ReasoningEffort) => void;
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
  reasoningEffort,
  onReasoningEffortChange,
  onSave,
  onClear,
  onDetectModels
}: ByokProviderCardProps) {
  const isConfigured = Boolean(currentKey);

  return (
    <div className="flex flex-col gap-4 p-4" data-testid={`byok-card-${provider.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex items-center gap-3">
          <h3 className="type-title text-base text-text">{provider.name}</h3>
          {isConfigured ? (
            <span
              className="inline-flex items-center gap-1 text-caption text-ok"
              data-testid={`byok-${provider.id}-status`}
            >
              <Icon icon={Check} size={13} />
              Key saved
            </span>
          ) : (
            <span className="text-caption text-text-muted" data-testid={`byok-${provider.id}-status`}>
              No key yet
            </span>
          )}
        </div>
        <a
          href={provider.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-caption text-text-secondary hover:text-accent hover:underline"
        >
          {provider.docsLabel}
          <Icon icon={ExternalLink} size={12} />
        </a>
      </div>

      {isConfigured && !isEditing ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-2">
              <span className="type-label text-caption text-text-secondary">Your key</span>
              <span
                className="truncate font-mono text-sm text-text"
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
                Replace key
              </Button>
              <Button
                variant="danger"
                size="sm"
                iconLeft={Trash2}
                onClick={onClear}
                data-testid={`byok-${provider.id}-clear`}
              >
                Clear key
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2" data-testid={`byok-${provider.id}-model-section`}>
            <div className="flex items-center justify-between gap-2">
              <span className="type-label text-caption text-text-secondary">Model</span>
              <Button
                variant="quiet"
                size="sm"
                iconLeft={RotateCw}
                disabled={loadingModels}
                onClick={onDetectModels}
                data-testid={`byok-${provider.id}-detect`}
              >
                {loadingModels ? "Loading models…" : "Refresh models"}
              </Button>
            </div>

            {loadingModels ? (
              <div className="flex min-h-11 items-center gap-2 text-caption text-text-secondary">
                <Spinner size={14} />
                <span>Loading the models your {provider.name} key can use…</span>
              </div>
            ) : customInput ? (
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <Input
                    mono
                    aria-label={`${provider.name} model ID`}
                    placeholder={`${provider.name} model ID`}
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
                    Use model
                  </Button>
                  <Button
                    variant="quiet"
                    size="sm"
                    onClick={() => onSetCustomInput(false)}
                  >
                    Cancel
                  </Button>
                </div>
                <span className="text-caption text-text-muted">Type any model ID your account can use.</span>
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
                  placeholder={`Pick a ${provider.name} model`}
                />
                {modelError ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 text-caption text-warn">
                    <span>Couldn&apos;t load the model list: {modelError}</span>
                    <button
                      type="button"
                      className="font-medium underline cursor-pointer"
                      onClick={() => onSetCustomInput(true)}
                    >
                      Type a model ID
                    </button>
                  </div>
                ) : (
                  <span className="text-caption text-text-muted">
                    {models?.length
                      ? `${models.length} models available to your key.`
                      : `Press Refresh models to list the models your ${provider.name} key can use.`}
                  </span>
                )}
              </div>
            )}

            <div className="flex flex-col gap-1.5 pt-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="type-label text-caption text-text-secondary">Reasoning effort</span>
                <span className="text-caption text-text-muted">Only for models that think before answering</span>
              </div>
              <div
                className="inline-flex self-start overflow-hidden rounded-btn border border-border"
                data-testid={`byok-${provider.id}-reasoning-effort`}
              >
                {(["default", "low", "medium", "high"] as const).map((effort) => {
                  const isSelected = (effort === "default" && !reasoningEffort) || reasoningEffort === effort;
                  return (
                    <button
                      key={effort}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => onReasoningEffortChange?.(effort === "default" ? undefined : effort)}
                      className={cn(
                        "text-caption min-h-9 border-l border-border px-3 transition-colors duration-150 cursor-pointer first:border-l-0",
                        isSelected
                          ? "bg-accent/10 font-medium text-accent"
                          : "bg-surface text-text-secondary hover:bg-surface-raised hover:text-text"
                      )}
                      data-testid={`byok-${provider.id}-effort-${effort}`}
                    >
                      {effort.charAt(0).toUpperCase() + effort.slice(1)}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Field
            label="API key"
            hint={
              persist
                ? "Kept in this browser's local storage until you clear it."
                : "Kept in this browser tab's session storage until you close the tab."
            }
          >
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

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Toggle
              checked={persist}
              onChange={onPersistChange}
              label="Remember for this browser"
              description="Keeps the key after you close the tab."
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
                Save key
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
