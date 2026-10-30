"use client";

import { useId, useMemo } from "react";
import { RefreshCw } from "lucide-react";
import type { DiscoveredModel } from "@/types/client";
import { groupModelsForPicker, isFreeModel } from "@/lib/llm/model-recommend";
import { cn } from "./cn";
import { IconButton, Input, Spinner, type FieldControlProps } from "./primitives";

// Model dropdowns are populated live but always accept an arbitrary model id,
// since some custom endpoints don't implement /v1/models listing.
export function ModelField({
  value,
  onChange,
  models,
  loading,
  onRefresh,
  error,
  disabled,
  inputProps
}: {
  value: string;
  onChange: (next: string) => void;
  models: DiscoveredModel[];
  loading?: boolean;
  onRefresh?: () => void;
  error?: string;
  disabled?: boolean;
  inputProps?: FieldControlProps;
}) {
  const listId = useId();
  // Tool-capable models first (free first), from discovery metadata only.
  // Providers without tool metadata show no quick picks and keep today's list.
  const recommended = useMemo(() => groupModelsForPicker(models).recommended.slice(0, 5), [models]);
  return (
    <div className="flex flex-col gap-1.5">
      {recommended.length > 0 ? (
        <div className="flex flex-col gap-1" data-testid="model-recommended">
          <span className="type-label text-caption text-text-secondary">
            Recommended: can use tools
          </span>
          <div className="flex flex-wrap gap-1.5">
            {recommended.map((model) => (
              <button
                key={model.id}
                type="button"
                onClick={() => onChange(model.id)}
                disabled={disabled}
                title={model.id}
                className={"text-caption " + cn(
                  "inline-flex items-center gap-1.5 rounded-chip border px-2 py-0.5 transition-colors duration-150 cursor-pointer",
                  value === model.id
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-border bg-surface text-text-secondary hover:text-text hover:border-text-muted"
                )}
              >
                {model.name && model.name !== model.id ? (
                  <span>{model.name}</span>
                ) : (
                  <span className="font-mono">{model.id}</span>
                )}
                {isFreeModel(model) ? <span className="type-label text-ok">Free</span> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            {...inputProps}
            mono
            list={listId}
            value={value}
            disabled={disabled}
            placeholder="Type or pick a model ID"
            onChange={(event) => onChange(event.target.value)}
          />
          {loading ? (
            <span className="absolute right-3 top-1/2 -translate-y-1/2">
              <Spinner size={14} />
            </span>
          ) : null}
        </div>
        {onRefresh ? (
          <IconButton icon={RefreshCw} label="Refresh model list" onClick={onRefresh} disabled={disabled || loading} />
        ) : null}
      </div>
      <datalist id={listId}>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name && model.name !== model.id ? model.name : model.id}
          </option>
        ))}
      </datalist>
      {error ? (
        <p className="text-caption text-warn">{error}</p>
      ) : (
        <p className={`text-caption text-text-muted ${loading ? "opacity-70" : ""}`}>
          {loading
            ? "Loading models…"
            : models.length
              ? `${models.length} models found. You can also type any model ID.`
              : "This server doesn't list its models. Type the model ID."}
        </p>
      )}
    </div>
  );
}
