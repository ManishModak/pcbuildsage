"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronUp,
  CircleCheck,
  GripVertical,
  Plus,
  Radio,
  Server,
  TriangleAlert,
  Trash2
} from "lucide-react";
import { fetchModels, isHostedMode, probeEntry } from "@/lib/api-client";
import { hasUiKey, saveUiKey } from "@/lib/client-config-store";
import { hasByokKey, setByokKey } from "@/lib/llm/client-byok-store";
import { formatLatency, getErrorMessage } from "@/lib/format";
import type {
  ChainEntry,
  CredentialAvailability,
  DiscoveredModel,
  EndpointPreset,
  KeySource,
  LLMProvider,
  ReasoningEffort
} from "@/types/client";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icon";
import { Button, Field, IconButton, Input, Spinner } from "@/components/ui/primitives";
import { ModelField } from "@/components/ui/model-field";
import { Select } from "@/components/ui/select";

const PROVIDERS: Array<{ value: LLMProvider; label: string }> = [
  { value: "gemini", label: "Google Gemini" },
  { value: "groq", label: "Groq" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "ollama", label: "Ollama (local)" },
  { value: "openai-compatible", label: "OpenAI-compatible" }
];

let entryCounter = 0;
export function newEntry(partial: Partial<ChainEntry> = {}): ChainEntry {
  entryCounter += 1;
  return {
    id: `entry-${Date.now()}-${entryCounter}`,
    provider: "gemini",
    model: "",
    keySource: "env",
    ...partial
  };
}

type ModelState = { models: DiscoveredModel[]; loading: boolean; error?: string };

export function ChainBuilder({
  chain,
  onChange,
  credentials,
  endpoints,
  primaryMustSupportTools = true
}: {
  chain: ChainEntry[];
  onChange: (next: ChainEntry[]) => void;
  credentials: CredentialAvailability | null;
  endpoints: EndpointPreset[];
  /** When true, entry #0 is blocked unless the probe reports tool support. */
  primaryMustSupportTools?: boolean;
}) {
  const [models, setModels] = useState<Record<string, ModelState>>({});
  const [probing, setProbing] = useState<Record<string, boolean>>({});
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
  const dragIndex = useRef<number | null>(null);

  const update = (id: string, patch: Partial<ChainEntry>) =>
    onChange(chain.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));

  const move = (from: number, to: number) => {
    if (to < 0 || to >= chain.length) return;
    const next = [...chain];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  };

  const loadModels = useCallback(
    async (entry: ChainEntry) => {
      setModels((prev) => ({ ...prev, [entry.id]: { models: prev[entry.id]?.models ?? [], loading: true } }));
      try {
        const list = await fetchModels({
          provider: entry.provider,
          baseUrl: entry.baseUrl,
          keySource: entry.keySource,
          apiKey: keyDraft[entry.id]
        });
        setModels((prev) => ({ ...prev, [entry.id]: { models: list, loading: false } }));
      } catch (error) {
        setModels((prev) => ({
          ...prev,
          [entry.id]: { models: prev[entry.id]?.models ?? [], loading: false, error: (error as Error).message }
        }));
      }
    },
    [keyDraft]
  );

  const probe = async (entry: ChainEntry) => {
    setProbing((prev) => ({ ...prev, [entry.id]: true }));
    try {
      const result = await probeEntry(entry, keyDraft[entry.id]);
      update(entry.id, { ping: result });
    } catch (error) {
      update(entry.id, {
        ping: {
          reachable: false,
          latencyMs: 0,
          toolCapable: false,
          hint: getErrorMessage(error instanceof Error ? error : new Error(String(error)))
        }
      });
    } finally {
      setProbing((prev) => ({ ...prev, [entry.id]: false }));
    }
  };

  const commitKey = (entry: ChainEntry) => {
    const draft = keyDraft[entry.id];
    if (draft && draft.trim()) {
      const trimmed = draft.trim();
      if (isHostedMode()) {
        setByokKey(entry.provider, trimmed, false);
      } else {
        saveUiKey(entry.provider, trimmed);
      }
      update(entry.id, { hasSavedKey: true });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {chain.map((entry, index) => (
        <ChainCard
          key={entry.id}
          entry={entry}
          index={index}
          total={chain.length}
          credentials={credentials}
          endpoints={endpoints}
          modelState={models[entry.id] ?? { models: [], loading: false }}
          keyDraft={keyDraft[entry.id] ?? ""}
          probing={Boolean(probing[entry.id])}
          primaryMustSupportTools={primaryMustSupportTools}
          onUpdate={(patch) => update(entry.id, patch)}
          onKeyDraft={(value) => setKeyDraft((prev) => ({ ...prev, [entry.id]: value }))}
          onCommitKey={() => commitKey(entry)}
          onLoadModels={() => loadModels(entry)}
          onProbe={() => probe(entry)}
          onMoveUp={() => move(index, index - 1)}
          onMoveDown={() => move(index, index + 1)}
          onRemove={() => onChange(chain.filter((item) => item.id !== entry.id))}
          onDragStart={() => (dragIndex.current = index)}
          onDrop={() => {
            if (dragIndex.current !== null) move(dragIndex.current, index);
            dragIndex.current = null;
          }}
        />
      ))}
      <Button variant="ghost" iconLeft={Plus} onClick={() => onChange([...chain, newEntry()])} className="self-start">
        Add fallback provider
      </Button>
    </div>
  );
}

function ChainCard({
  entry,
  index,
  total,
  credentials,
  endpoints,
  modelState,
  keyDraft,
  probing,
  primaryMustSupportTools,
  onUpdate,
  onKeyDraft,
  onCommitKey,
  onLoadModels,
  onProbe,
  onMoveUp,
  onMoveDown,
  onRemove,
  onDragStart,
  onDrop
}: {
  entry: ChainEntry;
  index: number;
  total: number;
  credentials: CredentialAvailability | null;
  endpoints: EndpointPreset[];
  modelState: ModelState;
  keyDraft: string;
  probing: boolean;
  primaryMustSupportTools: boolean;
  onUpdate: (patch: Partial<ChainEntry>) => void;
  onKeyDraft: (value: string) => void;
  onCommitKey: () => void;
  onLoadModels: () => void;
  onProbe: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const isLocal = entry.provider === "ollama" || entry.provider === "openai-compatible";
  const envAvailable = Boolean(credentials?.llm?.[entry.provider]);
  const isPrimary = index === 0;
  const toolBlocked = primaryMustSupportTools && isPrimary && entry.ping && !entry.ping.toolCapable;

  // Fetch models the first time a provider is shown / changed.
  useEffect(() => {
    onLoadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.provider, entry.baseUrl]);

  const keySourceOptions: Array<{ value: KeySource; label: string }> = [
    ...(envAvailable ? [{ value: "env" as KeySource, label: "Detected env key" }] : []),
    { value: "ui", label: "Enter a key" },
    ...(isLocal ? [{ value: "none" as KeySource, label: "No key (local)" }] : [])
  ];

  return (
    <div
      className={cn(
        "rounded-card border bg-surface",
        toolBlocked ? "border-blocking/60" : "border-border"
      )}
      style={toolBlocked ? { borderColor: "color-mix(in srgb, var(--blocking) 55%, transparent)" } : undefined}
      draggable
      onDragStart={onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="cursor-grab text-text-muted" title="Drag to reorder" aria-hidden>
          <Icon icon={GripVertical} size={16} />
        </span>
        <span className="font-mono text-caption text-text-secondary">
          {isPrimary ? "primary" : `fallback ${index}`}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton icon={ChevronUp} label="Move up" onClick={onMoveUp} disabled={index === 0} size={16} />
          <IconButton icon={ChevronDown} label="Move down" onClick={onMoveDown} disabled={index === total - 1} size={16} />
          <IconButton icon={Trash2} label="Remove provider" onClick={onRemove} size={16} />
        </div>
      </div>

      <div className="grid gap-3 p-3 sm:grid-cols-2">
        <Field label="Provider">
          {(controlProps) => (
            <Select
              {...controlProps}
              options={PROVIDERS}
              value={entry.provider}
              onChange={(event) =>
                onUpdate({ provider: event.target.value as LLMProvider, model: "", ping: undefined, hasSavedKey: false })
              }
            />
          )}
        </Field>

        {entry.provider === "openai-compatible" ? (
          <Field label="Local preset">
            {(controlProps) => (
              <Select
                {...controlProps}
                placeholder="Custom endpoint"
                value={entry.presetName ?? ""}
                options={endpoints.map((preset) => ({ value: preset.name, label: preset.name }))}
                onChange={(event) => {
                  const preset = endpoints.find((item) => item.name === event.target.value);
                  onUpdate(
                    preset
                      ? {
                          presetName: preset.name,
                          baseUrl: preset.base_url,
                          keySource: preset.requires_key ? "ui" : "none",
                          ping: undefined
                        }
                      : { presetName: undefined }
                  );
                }}
              />
            )}
          </Field>
        ) : (
          <Field label="Key source">
            {(controlProps) => (
              <Select
                {...controlProps}
                options={keySourceOptions}
                value={entry.keySource}
                onChange={(event) => onUpdate({ keySource: event.target.value as KeySource, ping: undefined })}
              />
            )}
          </Field>
        )}

        {isLocal ? (
          <Field label="Base URL" hint="host:port or …/v1 — normalized automatically">
            {(controlProps) => (
              <Input
                {...controlProps}
                mono
                value={entry.baseUrl ?? ""}
                placeholder={entry.provider === "ollama" ? "http://localhost:11434" : "http://localhost:8000/v1"}
                onChange={(event) => onUpdate({ baseUrl: event.target.value, ping: undefined })}
              />
            )}
          </Field>
        ) : null}

        {entry.provider === "openai-compatible" ? (
          <Field label="Key source">
            {(controlProps) => (
              <Select
                {...controlProps}
                options={keySourceOptions}
                value={entry.keySource}
                onChange={(event) => onUpdate({ keySource: event.target.value as KeySource, ping: undefined })}
              />
            )}
          </Field>
        ) : null}

        {entry.keySource === "ui" ? (
          (() => {
            const keySaved = Boolean(entry.hasSavedKey || (isHostedMode() ? hasByokKey(entry.provider) : hasUiKey(entry.provider)));
            return (
              <Field
                label="API key"
                hint={
                  keySaved
                    ? "A key is saved for this provider (write-only)."
                    : isHostedMode()
                    ? "Stored in ephemeral session storage, sent only as a request header."
                    : "Stored locally, sent only as a request header."
                }
              >
                {(controlProps) => (
                  <Input
                    {...controlProps}
                    type="password"
                    autoComplete="off"
                    value={keyDraft}
                    placeholder={keySaved ? "•••••••• saved" : "paste key"}
                    onChange={(event) => onKeyDraft(event.target.value)}
                    onBlur={onCommitKey}
                  />
                )}
              </Field>
            );
          })()
        ) : entry.keySource === "env" ? (
          <ReadOnlyValue label="Credential">
            <span className="inline-flex h-11 items-center gap-2 rounded-btn border border-border bg-surface px-3 text-caption text-text-secondary">
              <Icon icon={CircleCheck} size={15} className="text-accent" />
              Using detected environment key
            </span>
          </ReadOnlyValue>
        ) : (
          <ReadOnlyValue label="Credential">
            <span className="inline-flex h-11 items-center gap-2 rounded-btn border border-border bg-surface px-3 text-caption text-text-secondary">
              <Icon icon={Server} size={15} />
              Keyless local endpoint
            </span>
          </ReadOnlyValue>
        )}

        <div>
          <Field label="Model">
            {(controlProps) => (
              <ModelField
                inputProps={controlProps}
                value={entry.model}
                onChange={(value) => {
                  const matched = modelState.models.find((m) => m.id === value);
                  onUpdate({
                    model: value,
                    contextLimit: matched?.contextLimit,
                    ping: undefined
                  });
                }}
                models={modelState.models}
                loading={modelState.loading}
                onRefresh={onLoadModels}
                error={modelState.error}
              />
            )}
          </Field>
        </div>

        <div>
          <Field label="Reasoning effort" hint="For reasoning models (e.g. o3, DeepSeek R1)">
            {(controlProps) => (
              <Select
                {...controlProps}
                options={[
                  { value: "", label: "Default (provider default)" },
                  { value: "low", label: "Low" },
                  { value: "medium", label: "Medium" },
                  { value: "high", label: "High" }
                ]}
                value={entry.reasoningEffort ?? ""}
                onChange={(event) =>
                  onUpdate({
                    reasoningEffort: (event.target.value as ReasoningEffort) || undefined
                  })
                }
              />
            )}
          </Field>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-2.5">
        <Button variant="ghost" size="sm" iconLeft={Radio} onClick={onProbe} disabled={probing || !entry.model}>
          {probing ? "Verifying…" : "Ping & probe tools"}
        </Button>
        {probing ? <Spinner size={14} /> : null}
        {entry.ping ? <PingResultView entry={entry} /> : null}
        {toolBlocked ? (
          <span className="ml-auto inline-flex items-center gap-1.5 text-caption" style={{ color: "var(--blocking)" }}>
            <Icon icon={TriangleAlert} size={14} />
            Cannot be the chat primary until tools work
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ReadOnlyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-caption font-medium text-text-secondary">{label}</p>
      {children}
    </div>
  );
}

function PingResultView({ entry }: { entry: ChainEntry }) {
  const ping = entry.ping!;
  if (!ping.reachable) {
    return (
      <span className="inline-flex items-center gap-1.5 text-caption" style={{ color: "var(--warn)" }}>
        <Icon icon={TriangleAlert} size={14} />
        unreachable{ping.hint ? ` — ${truncate(ping.hint)}` : ""}
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2 text-caption">
      <span className="inline-flex items-center gap-1.5 text-accent">
        <Icon icon={CircleCheck} size={14} />
        reachable <span className="font-mono text-text-secondary">{formatLatency(ping.latencyMs)}</span>
      </span>
      {ping.toolCapable ? (
        <span className="inline-flex items-center gap-1.5 text-accent">
          <Icon icon={CircleCheck} size={14} />
          tool-capable
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5" style={{ color: "var(--warn)" }} title={ping.hint}>
          <Icon icon={TriangleAlert} size={14} />
          no tool support{ping.hint ? ` — ${truncate(ping.hint)}` : ""}
        </span>
      )}
    </span>
  );
}

function truncate(value: string, max = 90): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
