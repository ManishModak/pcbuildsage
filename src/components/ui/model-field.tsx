"use client";

import { useId } from "react";
import { RefreshCw } from "lucide-react";
import type { DiscoveredModel } from "@/types/client";
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
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            {...inputProps}
            mono
            list={listId}
            value={value}
            disabled={disabled}
            placeholder="model id (type or pick)"
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
        <p className={cn("text-caption text-text-muted", loading && "opacity-70")}>
          {loading
            ? "Fetching models…"
            : models.length
              ? `${models.length} models available — or type any id`
              : "Type a model id (listing unavailable for this endpoint)"}
        </p>
      )}
    </div>
  );
}
