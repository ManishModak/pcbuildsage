"use client";

import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Plus, RotateCw, Search } from "lucide-react";
import { fetchModels } from "@/lib/api-client";
import { clearUiKey, hasUiKey, readKeyMap, saveUiKey } from "@/lib/client-config-store";
import { getErrorMessage } from "@/lib/format";
import { LLM_PROVIDERS, type LLMProvider, type ProviderInfo, type ProviderTier } from "@/lib/llm/providers";
import { groupModelsForPicker, isFreeModel, isToolCapableModel } from "@/lib/llm/model-recommend";
import { newEntry } from "@/features/llm/chain-builder";
import type { ChainEntry, CredentialAvailability, DiscoveredModel, KeySource } from "@/types/client";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icon";
import { Button, Input, Spinner } from "@/components/ui/primitives";

const TIER_GROUPS: Array<{ tier: ProviderTier; label: string }> = [
  { tier: "free", label: "Free to start" },
  { tier: "trial", label: "Trial credits" },
  { tier: "paid", label: "Paid" },
  { tier: "local", label: "On your machine" }
];

type KeyState = "env" | "saved" | "none" | "local";

/** Where this provider's key comes from, for the list's status line. */
export function providerKeyState(provider: ProviderInfo, credentials: CredentialAvailability | null, savedKey: boolean): KeyState {
  if (provider.tier === "local") return "local";
  if (savedKey) return "saved";
  if (credentials?.llm?.[provider.id]) return "env";
  return "none";
}

const KEY_STATE_TEXT: Record<KeyState, string> = {
  env: "Key from the server's .env",
  saved: "Key saved in this browser",
  none: "No key yet",
  local: "No key needed"
};

/**
 * Local-mode Providers page: every provider in the registry, grouped by what
 * it costs to start, with its key and its models. A model is added to the chat
 * from here as the main model or a backup.
 */
export function ProvidersPage({
  chain,
  onChange,
  credentials
}: {
  chain: ChainEntry[];
  onChange: (next: ChainEntry[]) => void;
  credentials: CredentialAvailability | null;
}) {
  const [selectedId, setSelectedId] = useState<LLMProvider>(() => chain[0]?.provider ?? LLM_PROVIDERS[0].id);
  // Bumped when a key is saved or cleared, so the list's status lines re-read storage.
  const [keyVersion, setKeyVersion] = useState(0);
  const savedKeys = useMemo(
    () => Object.fromEntries(LLM_PROVIDERS.map((p) => [p.id, hasUiKey(p.id)])),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyVersion marks a storage change
    [keyVersion]
  );
  const selected = LLM_PROVIDERS.find((p) => p.id === selectedId) ?? LLM_PROVIDERS[0];
  const inUse = new Set(chain.map((entry) => entry.provider));

  const addModel = (provider: ProviderInfo, model: DiscoveredModel, as: "main" | "backup") => {
    const keySource: KeySource =
      provider.tier === "local" ? "none" : savedKeys[provider.id] ? "ui" : credentials?.llm?.[provider.id] ? "env" : "ui";
    const entry = newEntry({
      provider: provider.id as LLMProvider,
      model: model.id,
      keySource,
      ...(model.contextLimit ? { contextLimit: model.contextLimit } : {}),
      ...(keySource === "ui" ? { hasSavedKey: true } : {})
    });
    const rest = chain.filter((item) => !(item.provider === entry.provider && item.model === entry.model));
    onChange(as === "main" ? [entry, ...rest] : [...rest, entry]);
  };

  // Chat rows on this provider follow its key: a saved key overrides the .env
  // one, and clearing it falls back to .env when there is one.
  const keyChanged = (provider: ProviderInfo, saved: boolean) => {
    setKeyVersion((v) => v + 1);
    if (!chain.some((entry) => entry.provider === provider.id)) return;
    const keySource: KeySource = saved || !credentials?.llm?.[provider.id] ? "ui" : "env";
    onChange(
      chain.map((entry) =>
        entry.provider === provider.id ? { ...entry, keySource, hasSavedKey: saved, ping: undefined } : entry
      )
    );
  };

  return (
    <section className="flex flex-col gap-3" data-testid="providers-page" data-setting="Providers">
      <div className="flex flex-col gap-1 px-1">
        <h2 className="type-title text-lg text-text">Providers</h2>
        <p className="text-sm text-text-secondary">
          Add a key for a provider, then pick one of its models as your main model or a backup.
        </p>
      </div>
      <div className="flex flex-col overflow-hidden rounded-card border border-border bg-surface md:flex-row">
        <nav aria-label="Providers" className="flex shrink-0 flex-col border-b border-border md:w-60 md:border-b-0 md:border-r">
          {TIER_GROUPS.map((group) => {
            const providers = LLM_PROVIDERS.filter((p) => p.tier === group.tier);
            return (
              <div key={group.tier} className="flex flex-col py-1.5">
                <p className="type-label px-4 py-1 text-caption text-text-muted">{group.label}</p>
                {providers.map((provider) => {
                  const state = providerKeyState(provider, credentials, savedKeys[provider.id]);
                  const active = provider.id === selected.id;
                  return (
                    <button
                      key={provider.id}
                      type="button"
                      aria-current={active ? "true" : undefined}
                      onClick={() => setSelectedId(provider.id)}
                      data-testid={`provider-item-${provider.id}`}
                      className={cn(
                        "relative flex flex-col items-start gap-0.5 px-4 py-2 text-left transition-colors duration-150",
                        active ? "bg-surface-raised" : "hover:bg-surface-raised"
                      )}
                    >
                      {active ? <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-accent" /> : null}
                      <span className="flex items-center gap-2 text-sm font-medium text-text">
                        {provider.name}
                        {inUse.has(provider.id as LLMProvider) ? (
                          <span className="rounded-pill border border-border px-1.5 text-caption font-normal text-text-secondary">In use</span>
                        ) : null}
                      </span>
                      <span className={cn("text-caption", state === "none" ? "text-text-muted" : "text-text-secondary")}>
                        {KEY_STATE_TEXT[state]}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </nav>
        <ProviderDetail
          key={selected.id}
          provider={selected}
          envKey={Boolean(credentials?.llm?.[selected.id])}
          savedKey={savedKeys[selected.id]}
          onKeyChange={(saved) => keyChanged(selected, saved)}
          onAdd={(model, as) => addModel(selected, model, as)}
          chain={chain}
        />
      </div>
    </section>
  );
}

function ProviderDetail({
  provider,
  envKey,
  savedKey,
  onKeyChange,
  onAdd,
  chain
}: {
  provider: ProviderInfo;
  envKey: boolean;
  savedKey: boolean;
  onKeyChange: (saved: boolean) => void;
  onAdd: (model: DiscoveredModel, as: "main" | "backup") => void;
  chain: ChainEntry[];
}) {
  const local = provider.tier === "local";
  const [draft, setDraft] = useState("");
  const [models, setModels] = useState<DiscoveredModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const canList = local || savedKey || envKey;

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const apiKey = local ? undefined : readKeyMap()[provider.id];
      const keySource = local ? "none" : apiKey ? "ui" : "env";
      setModels(await fetchModels({ provider: provider.id, keySource, apiKey }));
    } catch (err) {
      setModels([]);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- list the models once a key is available
    if (canList) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the key changes
  }, [canList, savedKey]);

  const saveKey = () => {
    const key = draft.trim();
    if (!key) return;
    saveUiKey(provider.id, key);
    setDraft("");
    onKeyChange(true);
    // A first key lists the models through the effect below; a replaced one needs a fresh list.
    if (savedKey) void load();
  };

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matching = models.filter((m) => words.every((w) => `${m.id} ${m.name ?? ""}`.toLowerCase().includes(w)));
    const { recommended, rest } = groupModelsForPicker(matching);
    return [...recommended, ...rest];
  }, [models, query]);
  const mainModel = chain[0];

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-5 p-4 sm:p-5" data-testid={`provider-detail-${provider.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h3 className="type-title text-base text-text">{provider.name}</h3>
          <p className="text-caption text-text-secondary">{provider.note}</p>
        </div>
        {provider.keyUrl ? (
          <a
            href={provider.keyUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-caption text-accent hover:underline"
          >
            Get a key
            <Icon icon={ExternalLink} size={12} />
          </a>
        ) : null}
      </div>

      {local ? (
        <p className="text-sm text-text-secondary">
          {provider.id === "ollama"
            ? "Lists the models at OLLAMA_BASE_URL (or localhost:11434). Set another address on the chat model."
            : "Lists the models at OPENAI_COMPATIBLE_BASE_URL. Set the address, or pick a saved server, on the chat model."}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <label htmlFor={`provider-key-${provider.id}`} className="type-label text-caption text-text-secondary">
            API key
          </label>
          <div className="flex flex-wrap gap-2">
            <Input
              id={`provider-key-${provider.id}`}
              type="password"
              autoComplete="off"
              className="min-w-0 flex-1 bg-bg"
              placeholder={savedKey ? "•••••••• saved" : provider.keyPlaceholder ?? "Paste your key"}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveKey();
              }}
            />
            <Button variant="primary" onClick={saveKey} disabled={!draft.trim()}>
              Save key
            </Button>
            {savedKey ? (
              <Button
                variant="ghost"
                onClick={() => {
                  clearUiKey(provider.id);
                  onKeyChange(false);
                }}
              >
                Clear key
              </Button>
            ) : null}
          </div>
          <p className="text-caption text-text-muted">
            {savedKey
              ? "Saved in this browser's local storage. Sent with each request only so the PCBuildSage server can forward it to this provider."
              : envKey
                ? `Using ${provider.envKey} from the server's .env. Paste a key to use a different one in this browser.`
                : "Stored in this browser's local storage. Sent with each request only so the PCBuildSage server can forward it to this provider."}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <p className="type-label text-caption text-text-secondary">Models</p>
          {canList ? (
            <Button variant="ghost" size="sm" iconLeft={RotateCw} onClick={() => void load()} disabled={loading}>
              Refresh
            </Button>
          ) : null}
        </div>
        {!canList ? (
          <p className="text-sm text-text-muted">Add a key to list this provider&apos;s models.</p>
        ) : loading ? (
          <p className="flex items-center gap-2 text-sm text-text-secondary">
            <Spinner size={14} /> Listing models…
          </p>
        ) : error ? (
          <p className="text-sm text-warn" role="alert">
            {error}
          </p>
        ) : (
          <>
            <div className="relative">
              <Icon icon={Search} size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <Input
                aria-label={`Search ${provider.name} models`}
                className="bg-bg pl-8"
                placeholder={`Search ${models.length} models`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-btn border border-border" data-testid="provider-models">
              {shown.length === 0 ? (
                <li className="px-3 py-2 text-sm text-text-muted">No models match.</li>
              ) : (
                shown.map((model) => {
                  const isMain = mainModel?.provider === provider.id && mainModel.model === model.id;
                  const isBackup = chain.slice(1).some((e) => e.provider === provider.id && e.model === model.id);
                  return (
                    <li key={model.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-sm text-text" title={model.id}>
                        {model.id}
                      </span>
                      {isFreeModel(model) ? <Tag>Free</Tag> : null}
                      {isToolCapableModel(model) ? <Tag>Tools</Tag> : null}
                      {isMain ? (
                        <span className="text-caption text-text-secondary">Main model</span>
                      ) : (
                        <Button variant="ghost" size="sm" onClick={() => onAdd(model, "main")}>
                          Use as main
                        </Button>
                      )}
                      {isMain || isBackup ? null : (
                        <Button variant="ghost" size="sm" iconLeft={Plus} onClick={() => onAdd(model, "backup")}>
                          Backup
                        </Button>
                      )}
                    </li>
                  );
                })
              )}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function Tag({ children }: { children: string }) {
  return <span className="rounded-pill border border-border px-1.5 text-caption text-text-secondary">{children}</span>;
}
