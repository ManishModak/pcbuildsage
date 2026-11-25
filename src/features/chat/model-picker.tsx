"use client";

import Link from "next/link";
import { Popover as PopoverPrimitive } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Bot,
  Brain,
  Check,
  ChevronsUpDown,
  Compass,
  Cpu,
  Flame,
  Layers,
  Plus,
  RotateCw,
  Search,
  Server,
  Sparkles,
  Star,
  Terminal,
  TriangleAlert,
  Wind,
  X,
  Zap,
  type LucideIcon
} from "lucide-react";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/primitives";
import { RuneSpinner } from "@/components/app/rune-spinner";
import { fetchCredentials, fetchModels, isHostedMode } from "@/lib/api-client";
import { hasUiKey } from "@/lib/client-config-store";
import { getByokModel, hasByokKey } from "@/lib/llm/client-byok-store";
import { formatErrorMessageFallback } from "@/features/chat/model-picker-error";
import { formatModelName } from "@/lib/format";
import { getFreeTierWarning, supportsReasoning } from "@/lib/llm/model-capabilities";
import { getProvider } from "@/lib/llm/providers";
import type { ClientConfig, CredentialAvailability, DiscoveredModel, ReasoningEffort } from "@/types/client";
import type { ActiveSelection } from "./chat-config-resolver";
import {
  applyModelSwitchHosted,
  applyModelSwitchLocal,
  applyReasoningSwitchHosted,
  applyReasoningSwitchLocal,
  buildPickerSections,
  getEligibleProviders,
  resolveDiscoveryRequestParams,
  type PickerModelItem
} from "./model-picker-data";

export type RecoveryWait = "rate-limit" | "transient";

const REASONING_LEVELS: Array<{ value: ReasoningEffort | undefined; label: string; hint?: string }> = [
  { value: undefined, label: "Provider default", hint: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" }
];

const INITIAL_AVAILABLE_LIMIT = 80;
const SEARCH_RESULT_LIMIT = 150;

const discoveryCache = new Map<string, DiscoveredModel[]>();

export function clearModelPickerDiscoveryCacheForTesting(): void {
  discoveryCache.clear();
}

const PROVIDER_ICONS: Record<string, LucideIcon> = {
  gemini: Sparkles,
  groq: Zap,
  openrouter: Layers,
  nvidia: Cpu,
  cerebras: Flame,
  openai: Bot,
  anthropic: Brain,
  deepseek: Compass,
  xai: Terminal,
  mistral: Wind,
  ollama: Server,
  "openai-compatible": Server
};

function providerIconFor(id: string): LucideIcon {
  return PROVIDER_ICONS[id] ?? Bot;
}

function discoveryCacheKey(params: { provider: string; keySource: string; baseUrl?: string; apiKey?: string }): string {
  const keyTag = params.apiKey ? `k:${params.apiKey.length}:${params.apiKey.slice(-4)}` : "nokey";
  return `${params.provider}::${params.keySource}::${params.baseUrl ?? ""}::${keyTag}`;
}

export function ModelPicker({
  config,
  activeSelection,
  streaming,
  isCompacting,
  recovering,
  updateConfig,
  onByokSelectionChange,
  defaultOpen = false,
  initialDiscoveredByProvider,
  initialCredentials,
  isHostedOverride
}: {
  config: ClientConfig;
  activeSelection: ActiveSelection;
  streaming: boolean;
  isCompacting?: boolean;
  recovering?: RecoveryWait | null;
  updateConfig: (patch: Partial<ClientConfig> | ((prev: ClientConfig) => ClientConfig)) => void;
  onByokSelectionChange?: () => void;
  defaultOpen?: boolean;
  initialDiscoveredByProvider?: Record<string, DiscoveredModel[]>;
  initialCredentials?: CredentialAvailability | null;
  isHostedOverride?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [selectedProvider, setSelectedProvider] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [showAllAvailable, setShowAllAvailable] = useState(false);

  const [credentials, setCredentials] = useState<CredentialAvailability | null>(initialCredentials ?? null);
  const [credentialsLoaded, setCredentialsLoaded] = useState(initialCredentials !== undefined);
  const [localServerProviders, setLocalServerProviders] = useState<Set<string>>(() => new Set());
  const [discoveredByProvider, setDiscoveredByProvider] = useState<Record<string, DiscoveredModel[]>>(
    initialDiscoveredByProvider ?? {}
  );
  const [loadingProviders, setLoadingProviders] = useState<Record<string, boolean>>({});
  const [errorByProvider, setErrorByProvider] = useState<Record<string, string | undefined>>({});

  const searchInputRef = useRef<HTMLInputElement>(null);
  const isHosted = isHostedOverride !== undefined ? isHostedOverride : isHostedMode();
  const hasKeyFn = isHosted ? hasByokKey : hasUiKey;

  const eligibleProviders = useMemo(
    () =>
      getEligibleProviders({
        isHosted,
        chatChain: config.chatChain,
        subagentChain: config.subagentChain,
        credentials,
        hasKey: hasKeyFn,
        localServerProviders
      }),
    [isHosted, config.chatChain, config.subagentChain, credentials, hasKeyFn, localServerProviders]
  );

  // If the previously filtered provider disappeared (e.g. key cleared), fall back to All.
  const effectiveSelectedProvider =
    selectedProvider === "all" || eligibleProviders.some((p) => p.id === selectedProvider)
      ? selectedProvider
      : "all";

  const loadProviderModels = useCallback(
    async (providerId: string, forceRefresh = false) => {
      const provider = getProvider(providerId);
      if (!provider) return;
      const req = resolveDiscoveryRequestParams({
        provider,
        isHosted,
        chatChain: config.chatChain,
        subagentChain: config.subagentChain
      });
      if (isHosted && !req.apiKey) return;

      const cacheKey = discoveryCacheKey(req);
      if (!forceRefresh && discoveryCache.has(cacheKey)) {
        const cached = discoveryCache.get(cacheKey)!;
        setDiscoveredByProvider((prev) => (prev[providerId] === cached ? prev : { ...prev, [providerId]: cached }));
        return;
      }

      setLoadingProviders((prev) => ({ ...prev, [providerId]: true }));
      setErrorByProvider((prev) => ({ ...prev, [providerId]: undefined }));
      try {
        const list = await fetchModels(req);
        discoveryCache.set(cacheKey, list);
        setDiscoveredByProvider((prev) => ({ ...prev, [providerId]: list }));
      } catch (err) {
        setErrorByProvider((prev) => ({ ...prev, [providerId]: formatErrorMessageFallback(err) }));
      } finally {
        setLoadingProviders((prev) => ({ ...prev, [providerId]: false }));
      }
    },
    [isHosted, config.chatChain, config.subagentChain]
  );

  // Fetch local credentials and eligible providers' models when the popover opens.
  useEffect(() => {
    if (!open) return;
    if (!isHosted && !credentialsLoaded) {
      let cancelled = false;
      fetchCredentials()
        .then((creds) => {
          if (!cancelled) {
            setCredentials(creds);
            setCredentialsLoaded(true);
          }
        })
        .catch(() => {
          if (!cancelled) setCredentialsLoaded(true);
        });
      return () => {
        cancelled = true;
      };
    }
  }, [open, isHosted, credentialsLoaded]);

  // Silently check if Ollama is running locally on default localhost when in local mode.
  const probedLocalOllamaRef = useRef(false);
  useEffect(() => {
    if (!open || isHosted || probedLocalOllamaRef.current) return;
    if (eligibleProviders.some((p) => p.id === "ollama")) return;
    probedLocalOllamaRef.current = true;
    fetchModels({ provider: "ollama", keySource: "none" })
      .then((list) => {
        if (list.length > 0) {
          discoveryCache.set(discoveryCacheKey({ provider: "ollama", keySource: "none" }), list);
          setDiscoveredByProvider((prev) => ({ ...prev, ollama: list }));
          setLocalServerProviders((prev) => {
            const next = new Set(prev);
            next.add("ollama");
            return next;
          });
        }
      })
      .catch(() => {
        // Local Ollama not running; ignore quietly.
      });
  }, [open, isHosted, eligibleProviders]);

  useEffect(() => {
    if (!open) return;
    for (const provider of eligibleProviders) {
      if (initialDiscoveredByProvider?.[provider.id]) continue;
      if (discoveredByProvider[provider.id] || loadingProviders[provider.id] || errorByProvider[provider.id]) {
        continue;
      }
      void loadProviderModels(provider.id, false);
    }
  }, [
    open,
    eligibleProviders,
    initialDiscoveredByProvider,
    discoveredByProvider,
    loadingProviders,
    errorByProvider,
    loadProviderModels
  ]);

  const sections = useMemo(
    () =>
      buildPickerSections({
        eligibleProviders,
        isHosted,
        chatChain: config.chatChain,
        activeProvider: activeSelection.provider,
        activeModel: activeSelection.model,
        getByokModel,
        discoveredByProvider,
        selectedProvider: effectiveSelectedProvider,
        query
      }),
    [
      eligibleProviders,
      isHosted,
      config.chatChain,
      activeSelection.provider,
      activeSelection.model,
      discoveredByProvider,
      effectiveSelectedProvider,
      query
    ]
  );

  const activeDiscoveredMeta = useMemo(() => {
    if (!activeSelection.provider) return undefined;
    return (discoveredByProvider[activeSelection.provider] ?? []).find((m) => m.id === activeSelection.model);
  }, [activeSelection.provider, activeSelection.model, discoveredByProvider]);

  const activeSupportsReasoning = Boolean(
    activeSelection.provider &&
      supportsReasoning(activeSelection.provider, activeSelection.model, activeDiscoveredMeta)
  );

  const handleSelectModel = (item: Pick<PickerModelItem, "provider" | "model" | "contextLimit" | "supportedParameters">) => {
    if (isHosted) {
      applyModelSwitchHosted({
        provider: item.provider,
        model: item.model,
        supportedParameters: item.supportedParameters
      });
      onByokSelectionChange?.();
    } else {
      updateConfig((prev) =>
        applyModelSwitchLocal(prev, {
          provider: item.provider,
          model: item.model,
          contextLimit: item.contextLimit,
          supportedParameters: item.supportedParameters,
          credentials
        })
      );
    }
    setOpen(false);
  };

  const handleSelectReasoning = (effort?: ReasoningEffort) => {
    if (!activeSelection.provider || !activeSupportsReasoning) return;
    if (isHosted) {
      applyReasoningSwitchHosted(activeSelection.provider, activeSelection.model, effort);
      onByokSelectionChange?.();
    } else {
      updateConfig((prev) => applyReasoningSwitchLocal(prev, effort));
    }
  };

  const displayName = useMemo(() => formatModelName(activeSelection.model), [activeSelection.model]);
  const busy = streaming || isCompacting || Boolean(recovering);

  const trimmedQuery = query.trim();
  const hasSearch = trimmedQuery.length > 0;
  const maxAvailable = hasSearch ? SEARCH_RESULT_LIMIT : showAllAvailable ? Infinity : INITIAL_AVAILABLE_LIMIT;
  const visibleRecommended = sections.recommended.slice(0, maxAvailable);
  const remainingBudget = Math.max(0, maxAvailable - visibleRecommended.length);
  const visibleAvailable = sections.available.slice(0, remainingBudget);
  const totalDiscoveredShown = sections.recommended.length + sections.available.length;
  const hiddenCount = Math.max(0, totalDiscoveredShown - (visibleRecommended.length + visibleAvailable.length));

  const anyLoading = eligibleProviders.some((p) => loadingProviders[p.id]);
  const filteredErrors = eligibleProviders
    .filter((p) => (effectiveSelectedProvider === "all" || effectiveSelectedProvider === p.id) && errorByProvider[p.id])
    .map((p) => ({ provider: p, error: errorByProvider[p.id]! }));

  const showGroqBanner =
    effectiveSelectedProvider === "groq" ||
    (activeSelection.provider === "groq" && effectiveSelectedProvider === "all");
  const groqWarning = showGroqBanner ? getFreeTierWarning("groq") : null;

  const canAddCustomModel =
    hasSearch &&
    effectiveSelectedProvider !== "all" &&
    sections.configured.length === 0 &&
    sections.recommended.length === 0 &&
    sections.available.length === 0;

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery("");
          setShowAllAvailable(false);
        }
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          data-testid="model-picker-trigger"
          aria-label={`Select chat model (${displayName})`}
          title={activeSelection.model ? `Model: ${activeSelection.model} — click to switch` : "Switch model"}
          className={cn(
            "group inline-flex max-w-full min-w-0 select-none items-center gap-2 rounded-btn px-2 py-1 text-left text-caption text-text-muted transition-colors duration-150 cursor-pointer",
            "hover:bg-surface-raised hover:text-text-secondary",
            open && "bg-surface-raised text-text-secondary"
          )}
        >
          <span
            aria-hidden
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              isCompacting || recovering === "rate-limit" ? "bg-warn" : streaming || recovering ? "bg-accent" : "bg-ok"
            )}
          />
          <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
            <span className="truncate font-mono text-text-secondary group-hover:text-text" data-testid="model-picker-active-name">
              {displayName}
            </span>
            {activeSupportsReasoning && activeSelection.reasoningEffort ? (
              <span className="shrink-0 rounded-chip border border-border px-1.5 py-px text-[11px] font-medium capitalize text-text-secondary">
                {activeSelection.reasoningEffort}
              </span>
            ) : null}
            <span className="shrink-0">
              {recovering === "rate-limit"
                ? "is waiting out the rate limit"
                : recovering
                  ? "is retrying"
                  : isCompacting
                    ? "is shortening the chat"
                    : streaming
                      ? "is answering"
                      : "ready"}
            </span>
          </span>
          {busy ? <RuneSpinner /> : null}
          <Icon icon={ChevronsUpDown} size={13} className="shrink-0 text-text-muted group-hover:text-text-secondary" />
        </button>
      </PopoverPrimitive.Trigger>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            searchInputRef.current?.focus();
          }}
          data-testid="model-picker-popover"
          className={cn(
            "z-50 flex flex-col overflow-hidden rounded-dialog border border-border bg-surface text-text outline-none",
            "shadow-[0_18px_40px_-16px_color-mix(in_srgb,var(--bg)_82%,black)]",
            "w-[calc(100vw-24px)] max-h-[min(480px,calc(100dvh-120px))]",
            activeSupportsReasoning ? "sm:w-[min(640px,calc(100vw-24px))]" : "sm:w-[min(460px,calc(100vw-24px))]"
          )}
        >
          {/* Main multi-pane body */}
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            {/* Left provider rail (horizontal strip on mobile, vertical icon rail on sm+) */}
            <nav
              aria-label="Configured providers"
              data-testid="model-picker-provider-rail"
              className="flex shrink-0 flex-row items-center gap-1 overflow-x-auto border-b border-border bg-surface-raised/40 p-1.5 scrollbar-none sm:w-12 sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r sm:py-2"
            >
              <RailButton
                active={effectiveSelectedProvider === "all"}
                label="All configured providers"
                icon={Star}
                onClick={() => {
                  setSelectedProvider("all");
                  setShowAllAvailable(false);
                }}
                testId="picker-provider-all"
              />
              {eligibleProviders.map((provider) => (
                <RailButton
                  key={provider.id}
                  active={effectiveSelectedProvider === provider.id}
                  label={provider.name}
                  icon={providerIconFor(provider.id)}
                  onClick={() => {
                    setSelectedProvider(provider.id);
                    setShowAllAvailable(false);
                    void loadProviderModels(provider.id, false);
                  }}
                  testId={`picker-provider-${provider.id}`}
                />
              ))}
            </nav>

            {/* Center searchable model list */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {/* Search header */}
              <div className="flex items-center gap-2 border-b border-border px-3 py-2 transition-colors duration-150 focus-within:border-accent">
                <Icon icon={Search} size={15} className="shrink-0 text-text-muted" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setShowAllAvailable(false);
                  }}
                  placeholder={
                    effectiveSelectedProvider === "all"
                      ? "Search models…"
                      : `Search ${getProvider(effectiveSelectedProvider)?.name ?? effectiveSelectedProvider} models…`
                  }
                  aria-label="Search models"
                  data-testid="model-picker-search"
                  className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none focus-visible:outline-none placeholder:text-text-muted"
                />
                {query ? (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label="Clear search"
                    className="rounded-btn p-1 text-text-muted hover:bg-surface-raised hover:text-text cursor-pointer"
                  >
                    <Icon icon={X} size={14} />
                  </button>
                ) : null}
                {effectiveSelectedProvider !== "all" ? (
                  <button
                    type="button"
                    onClick={() => void loadProviderModels(effectiveSelectedProvider, true)}
                    disabled={Boolean(loadingProviders[effectiveSelectedProvider])}
                    title="Refresh models"
                    aria-label="Refresh models"
                    className="rounded-btn p-1 text-text-muted hover:bg-surface-raised hover:text-text disabled:opacity-40 cursor-pointer"
                  >
                    <Icon
                      icon={RotateCw}
                      size={14}
                      className={loadingProviders[effectiveSelectedProvider] ? "pcbs-spin" : undefined}
                    />
                  </button>
                ) : null}
              </div>

              {/* Groq free-tier warning banner */}
              {groqWarning ? (
                <div
                  role="note"
                  data-testid="groq-free-tier-banner"
                  className="flex items-start gap-2 border-b border-border bg-warn/10 px-3 py-2 text-caption text-text-secondary"
                >
                  <Icon icon={TriangleAlert} size={14} className="mt-0.5 shrink-0 text-warn" />
                  <span>{groqWarning.detail}</span>
                </div>
              ) : null}

              {/* Scrollable list */}
              <div
                className="min-h-0 flex-1 overflow-y-auto py-1.5"
                role="listbox"
                aria-label="Available chat models"
                data-testid="model-picker-list"
              >
                {eligibleProviders.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
                    <p className="text-sm text-text-secondary">
                      {isHosted
                        ? "No API keys added in this browser yet."
                        : "No configured model providers found yet."}
                    </p>
                    <Link
                      href="/settings?tab=llm"
                      onClick={() => setOpen(false)}
                      className="text-caption font-medium text-accent hover:underline"
                    >
                      Add a key or model in Settings
                    </Link>
                  </div>
                ) : (
                  <>
                    {sections.configured.length > 0 ? (
                      <div>
                        <SectionHeading label="Configured" />
                        {sections.configured.map((item) => (
                          <ModelOptionRow
                            key={`cfg-${item.provider}-${item.model}`}
                            item={item}
                            selected={activeSelection.provider === item.provider && activeSelection.model === item.model}
                            showProvider={effectiveSelectedProvider === "all"}
                            onSelect={handleSelectModel}
                          />
                        ))}
                      </div>
                    ) : null}

                    {visibleRecommended.length > 0 ? (
                      <div>
                        <SectionHeading label="Recommended · tools" />
                        {visibleRecommended.map((item) => (
                          <ModelOptionRow
                            key={`rec-${item.provider}-${item.model}`}
                            item={item}
                            selected={activeSelection.provider === item.provider && activeSelection.model === item.model}
                            showProvider={effectiveSelectedProvider === "all"}
                            onSelect={handleSelectModel}
                          />
                        ))}
                      </div>
                    ) : null}

                    {visibleAvailable.length > 0 ? (
                      <div>
                        <SectionHeading label={visibleRecommended.length > 0 ? "All models" : "Available"} />
                        {visibleAvailable.map((item) => (
                          <ModelOptionRow
                            key={`avail-${item.provider}-${item.model}`}
                            item={item}
                            selected={activeSelection.provider === item.provider && activeSelection.model === item.model}
                            showProvider={effectiveSelectedProvider === "all"}
                            onSelect={handleSelectModel}
                          />
                        ))}
                      </div>
                    ) : null}

                    {hiddenCount > 0 ? (
                      <div className="px-3 py-2 text-center">
                        {hasSearch ? (
                          <span className="text-caption text-text-muted">
                            Showing first {SEARCH_RESULT_LIMIT} matches ({hiddenCount} more — refine your search)
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setShowAllAvailable(true)}
                            data-testid="model-picker-show-all"
                            className="text-caption font-medium text-accent hover:underline cursor-pointer"
                          >
                            Show {hiddenCount} more models
                          </button>
                        )}
                      </div>
                    ) : null}

                    {anyLoading && totalDiscoveredShown === 0 ? (
                      <div className="flex items-center gap-2 px-3 py-3 text-caption text-text-muted">
                        <Spinner size={14} />
                        <span>Loading models from your configured providers…</span>
                      </div>
                    ) : null}

                    {filteredErrors.map(({ provider, error }) => (
                      <div
                        key={`err-${provider.id}`}
                        className="mx-2 my-1 flex items-center justify-between gap-2 rounded-btn border border-border bg-surface-raised/60 px-2.5 py-1.5 text-caption text-text-muted"
                      >
                        <span className="truncate">
                          {provider.name}: {error}
                        </span>
                        <button
                          type="button"
                          onClick={() => void loadProviderModels(provider.id, true)}
                          className="shrink-0 font-medium text-accent hover:underline cursor-pointer"
                        >
                          Retry
                        </button>
                      </div>
                    ))}

                    {!anyLoading &&
                    sections.configured.length === 0 &&
                    sections.recommended.length === 0 &&
                    sections.available.length === 0 ? (
                      <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
                        <span className="text-sm text-text-secondary">
                          {hasSearch ? `No models match "${trimmedQuery}"` : "No models listed yet."}
                        </span>
                        {canAddCustomModel ? (
                          <button
                            type="button"
                            onClick={() =>
                              handleSelectModel({
                                provider: effectiveSelectedProvider as PickerModelItem["provider"],
                                model: trimmedQuery
                              })
                            }
                            data-testid="model-picker-use-custom"
                            className="inline-flex items-center gap-1 text-caption font-medium text-accent hover:underline cursor-pointer"
                          >
                            <Icon icon={Plus} size={13} />
                            Use &ldquo;{trimmedQuery}&rdquo;
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            </div>

            {/* Desktop right pane: Reasoning level selector (only for thinking models) */}
            {activeSupportsReasoning ? (
              <div
                data-testid="model-picker-reasoning-pane"
                className="hidden shrink-0 flex-col border-l border-border bg-surface-raised/25 sm:flex sm:w-44"
              >
                <div className="flex items-baseline justify-between gap-2 border-b border-border px-3 py-2">
                  <span className="type-label text-caption text-text-secondary">Reasoning</span>
                  <span className="truncate font-mono text-[11px] text-text-muted" title={activeSelection.model}>
                    {displayName}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5 p-1.5" role="radiogroup" aria-label="Reasoning level">
                  {REASONING_LEVELS.map((level) => {
                    const isSelected = (activeSelection.reasoningEffort ?? undefined) === level.value;
                    return (
                      <button
                        key={level.label}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        onClick={() => handleSelectReasoning(level.value)}
                        data-testid={`picker-reasoning-${level.value ?? "default"}`}
                        className={cn(
                          "flex w-full items-center justify-between gap-2 rounded-btn px-2.5 py-2 text-left text-sm transition-colors duration-150 cursor-pointer",
                          isSelected
                            ? "bg-accent/12 font-medium text-accent"
                            : "text-text-secondary hover:bg-surface-raised hover:text-text"
                        )}
                      >
                        <span className="truncate">{level.hint ?? level.label}</span>
                        {isSelected ? <Icon icon={Check} size={14} className="shrink-0 text-accent" /> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>

          {/* Mobile reasoning selector strip (only for thinking models) */}
          {activeSupportsReasoning ? (
            <div
              data-testid="model-picker-reasoning-mobile"
              className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface-raised/25 px-3 py-2 sm:hidden"
            >
              <span className="type-label text-caption text-text-secondary">Reasoning</span>
              <div className="inline-flex overflow-hidden rounded-btn border border-border" role="radiogroup" aria-label="Reasoning level">
                {REASONING_LEVELS.map((level) => {
                  const isSelected = (activeSelection.reasoningEffort ?? undefined) === level.value;
                  return (
                    <button
                      key={level.label}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      onClick={() => handleSelectReasoning(level.value)}
                      data-testid={`picker-reasoning-mobile-${level.value ?? "default"}`}
                      className={cn(
                        "border-l border-border px-2.5 py-1 text-caption transition-colors duration-150 first:border-l-0 cursor-pointer",
                        isSelected
                          ? "bg-accent/12 font-medium text-accent"
                          : "bg-surface text-text-secondary hover:bg-surface-raised hover:text-text"
                      )}
                    >
                      {level.hint ?? level.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* Footer */}
          <div className="flex items-center justify-between gap-3 border-t border-border bg-surface-raised/40 px-3 py-2 text-caption text-text-muted">
            <span className="truncate">
              {streaming ? "Applies from next message" : "Chat model"}
            </span>
            <Link
              href="/settings?tab=llm"
              onClick={() => setOpen(false)}
              data-testid="model-picker-settings-link"
              className="inline-flex shrink-0 items-center gap-1 font-medium text-text-secondary transition-colors duration-150 hover:text-accent hover:underline"
            >
              <span>Keys &amp; backups in Settings</span>
              <Icon icon={ArrowUpRight} size={13} />
            </Link>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function RailButton({
  active,
  label,
  icon,
  onClick,
  testId
}: {
  active: boolean;
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
      className={cn(
        "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-btn transition-colors duration-150 cursor-pointer",
        active
          ? "bg-surface text-accent shadow-[inset_0_0_0_1px_var(--border)]"
          : "text-text-muted hover:bg-surface hover:text-text"
      )}
    >
      {active ? (
        <span
          aria-hidden
          className="absolute bottom-0.5 left-2 right-2 h-0.5 rounded-pill bg-accent sm:bottom-1.5 sm:left-0 sm:right-auto sm:top-1.5 sm:h-auto sm:w-0.5"
        />
      ) : null}
      <Icon icon={icon} size={16} />
    </button>
  );
}

function SectionHeading({ label }: { label: string }) {
  return (
    <div className="type-label px-3 pb-1 pt-2 text-[11px] uppercase tracking-wider text-text-muted">
      {label}
    </div>
  );
}

function ModelOptionRow({
  item,
  selected,
  showProvider,
  onSelect
}: {
  item: PickerModelItem;
  selected: boolean;
  showProvider: boolean;
  onSelect: (item: PickerModelItem) => void;
}) {
  const ProviderIcon = providerIconFor(item.provider);
  const label = item.name && item.name !== item.model ? item.name : formatModelName(item.model);
  const showRawId = label !== item.model;

  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={() => onSelect(item)}
      data-testid={`picker-model-${item.provider}-${item.model}`}
      className={cn(
        "flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors duration-150 cursor-pointer",
        "hover:bg-surface-raised",
        selected && "bg-accent/10"
      )}
    >
      <Icon
        icon={ProviderIcon}
        size={15}
        className={cn("shrink-0", selected ? "text-accent" : "text-text-muted")}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate text-sm", selected ? "font-medium text-accent" : "text-text")}>
            {label}
          </span>
          {item.free ? (
            <span className="shrink-0 rounded-chip border border-border px-1.5 text-[11px] font-medium text-ok">
              Free
            </span>
          ) : null}
          {item.freeTierWarning ? (
            <span
              title={item.freeTierWarning.detail}
              data-testid={`groq-warning-${item.model}`}
              className="inline-flex shrink-0 items-center gap-1 rounded-chip border border-warn/40 bg-warn/10 px-1.5 py-px text-[11px] font-medium text-warn"
            >
              <Icon icon={TriangleAlert} size={11} />
              <span>{item.freeTierWarning.badge}</span>
            </span>
          ) : null}
        </div>
        {showRawId || showProvider ? (
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-text-muted">
            {showProvider ? <span className="shrink-0">{item.providerLabel}</span> : null}
            {showProvider && showRawId ? <span aria-hidden>·</span> : null}
            {showRawId ? <span className="truncate font-mono">{item.model}</span> : null}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {item.configuredBadge ? (
          <span className="rounded-chip border border-border px-1.5 py-0.5 text-[11px] text-text-secondary">
            {item.configuredBadge}
          </span>
        ) : null}
        {selected ? <Icon icon={Check} size={15} className="text-accent" /> : null}
      </div>
    </button>
  );
}
