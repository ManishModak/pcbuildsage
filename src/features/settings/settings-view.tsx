"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Database, Download, Globe, KeyRound, Search, Sliders, Sparkles, Wand2, X } from "lucide-react";
import { useApp } from "@/components/app/app-provider";
import {
  exportResearch,
  fetchCredentials,
  fetchEndpoints,
  fetchPersonalities,
  fetchStatus,
  isHostedMode
} from "@/lib/api-client";
import type { ChainEntry, CredentialAvailability, EndpointPreset, LLMProvider, Personality, SearchProvider } from "@/types/client";
import { saveUiKey, type KeyMap } from "@/lib/client-config-store";
import { getErrorMessage } from "@/lib/format";
import { themeLabel } from "@/lib/theme";
import { openSetup } from "@/components/app/setup-hash";
import { ChainBuilder } from "@/features/llm/chain-builder";
import { MarketPreferenceSection } from "./market-preference-section";
import { ByokSection } from "./byok-section";
import { ProvidersPage } from "./providers-page";
import { providerName } from "@/lib/llm/providers";
import { KEY_HANDLING_SENTENCES } from "./key-help-panel";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icon";
import { Button, ChoiceControl, ChoiceGroup, Input, IconButton } from "@/components/ui/primitives";
import { Select } from "@/components/ui/select";
import { SettingsActionRow, SettingsGroup, SettingsRow, SettingsToggleRow } from "./settings-rows";

export type SettingsTab = "market" | "llm" | "providers" | "search" | "personalization" | "database";
type EndpointCatalogState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; endpoints: EndpointPreset[] };
type PersonalityCatalogState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; personalities: Personality[] };

import {
  clearByokKey,
  getByokKey,
  isByokKeyPersistent,
  setByokKey
} from "@/lib/llm/client-byok-store";

// The nav's groups, in display order.
const NAV_GROUPS = ["Assistant", "Preferences", "Data"] as const;

type SettingsNavItem = {
  id: SettingsTab;
  label: string;
  icon: typeof Sparkles;
  group: (typeof NAV_GROUPS)[number];
  /** What the page holds, so the nav search finds it by a setting's name. */
  keywords: string;
};

const NAV = {
  llm: {
    id: "llm",
    label: "AI model",
    icon: Sparkles,
    group: "Assistant",
    keywords: "chat models main model backup provider saved server address api key status reasoning effort context window tokens check add remember browser ollama gemini openrouter groq"
  },
  providers: {
    id: "providers",
    label: "Providers",
    icon: KeyRound,
    group: "Assistant",
    keywords: "api key keys provider models list free paid trial local gemini groq openrouter nvidia cerebras openai anthropic claude deepseek xai grok mistral ollama server use as main backup"
  },
  search: {
    id: "search",
    label: "Web research",
    icon: Search,
    group: "Assistant",
    keywords: "web search with searxng address api key read the top result page reader research model test brave tavily exa crawl"
  },
  personalization: {
    id: "personalization",
    label: "Look and tone",
    icon: Sliders,
    group: "Preferences",
    keywords: "appearance theme dark light colours colors tone personality voice country region currency"
  },
  market: {
    id: "market",
    label: "Region and currency",
    icon: Globe,
    group: "Preferences",
    keywords: "country region currency market prices retailers"
  },
  database: {
    id: "database",
    label: "Catalog",
    icon: Database,
    group: "Data",
    keywords: "spec research missing specs show research in chat answer open questions catalog share researched specs export product catalog setup prices products database scrape retailers"
  }
} satisfies Record<SettingsTab, SettingsNavItem>;

const SEARCH_FILLER = new Set(["a", "an", "and", "or", "the", "of", "to", "for", "in", "on", "my", "your", "this"]);

/**
 * The pages the nav search shows: every word of the query must appear in a
 * page's label or keywords, in any order ("API key", "key api"). Punctuation
 * and filler words like "or" are skipped, and an empty query shows every page.
 */
export function findSettingsPages(items: SettingsNavItem[], query: string): SettingsNavItem[] {
  const words = queryWords(query);
  if (!words.length) return items;
  return items.filter((item) => matchesWords(`${item.label} ${item.keywords}`, words));
}

function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word && !SEARCH_FILLER.has(word));
}

function matchesWords(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.every((word) => lower.includes(word));
}

/**
 * One setting the search can jump to. `label` is the row's title exactly as
 * shown (rows carry it as data-setting), and the page differs by mode where
 * the setting lives on different pages.
 */
type SettingIndexEntry = {
  label: string;
  local?: SettingsTab;
  hosted?: SettingsTab;
  keywords?: string;
  /** The row to show instead while this one is hidden (it needs that setting turned on). */
  shownWith?: string;
};

export const SETTING_INDEX: SettingIndexEntry[] = [
  { label: "Chat models", local: "llm", keywords: "main model backup fallback order check reasoning effort context window" },
  { label: "Providers", local: "providers", keywords: "api key keys models free paid use as main backup" },
  { label: "Search with", local: "search", hosted: "search", keywords: "web search provider brave tavily exa searxng" },
  { label: "Research model", local: "search", hosted: "search", keywords: "subagent same as chat", shownWith: "Search with" },
  { label: "Test search", local: "search", hosted: "search", keywords: "probe check", shownWith: "Search with" },
  { label: "Theme", local: "personalization", hosted: "personalization", keywords: "appearance colours colors dark light" },
  { label: "Tone", local: "personalization", hosted: "personalization", keywords: "personality voice" },
  { label: "Country or region", local: "personalization", hosted: "market", keywords: "market retailers" },
  { label: "Currency", local: "personalization", hosted: "market", keywords: "prices" },
  { label: "Research missing specs", local: "database", keywords: "spec research" },
  { label: "Show research in chat", local: "database" },
  { label: "Answer open questions", local: "database", keywords: "freeform consult" },
  { label: "Share researched specs", local: "database", keywords: "export" },
  { label: "Product catalog", local: "database", keywords: "setup scrape database retailers" }
];

export type SettingMatch = { label: string; tab: SettingsTab };

/** The individual settings a search finds, with the page each opens; empty for an empty query. */
export function findSettings(query: string, hosted: boolean, limit = 8): SettingMatch[] {
  const words = queryWords(query);
  if (!words.length) return [];
  return SETTING_INDEX.flatMap((entry) => {
    const tab = hosted ? entry.hosted : entry.local;
    return tab && matchesWords(`${entry.label} ${entry.keywords ?? ""}`, words) ? [{ label: entry.label, tab }] : [];
  }).slice(0, limit);
}

/** Scrolls to the setting titled `label` on the open page and flashes it; false when it isn't shown. */
function revealSetting(container: HTMLElement | null, label: string): boolean {
  const target = Array.from(container?.querySelectorAll<HTMLElement>("[data-setting]") ?? []).find(
    (element) => element.dataset.setting === label
  );
  if (!target) return false;
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  target.classList.add("setting-flash");
  window.setTimeout(() => target.classList.remove("setting-flash"), 1600);
  return true;
}

// Tab ids are URL values (?tab=…) and stay fixed; only the labels are user-facing.
export const LOCAL_NAV_ITEMS: SettingsNavItem[] = [NAV.llm, NAV.providers, NAV.search, NAV.personalization, NAV.database];

export const HOSTED_NAV_ITEMS: SettingsNavItem[] = [NAV.market, NAV.llm, NAV.search, NAV.personalization];

// Display names for search providers that take a key.
const SEARCH_PROVIDER_NAMES: Record<string, string> = { brave: "Brave Search", tavily: "Tavily", exa: "Exa" };

/**
 * Deep links like /settings?tab=database open straight to that panel. Read as
 * lazy initial state rather than in an effect: SettingsView only mounts once
 * the app provider reports `ready`, which is always post-hydration, so there is
 * no server render for this to disagree with.
 */
export function settingsTabFromSearch(search: string, hosted = isHostedMode()): SettingsTab {
  const requested = new URLSearchParams(search).get("tab");
  if (hosted && (requested === "database" || requested === "scrape")) return "market";
  // Locally, region and currency live on Look and tone.
  if (requested === "market") return hosted ? "market" : "personalization";
  if (requested === "byok") return "llm";
  const items = hosted ? HOSTED_NAV_ITEMS : LOCAL_NAV_ITEMS;
  return items.some((item) => item.id === requested) ? (requested as SettingsTab) : (hosted ? "market" : "llm");
}

const SAME_AS_CHAT = "same-as-chat";
const CURRENT_RESEARCH = "current-research";

function sameModel(a: Pick<ChainEntry, "provider" | "model">, b: Pick<ChainEntry, "provider" | "model">): boolean {
  return a.provider === b.provider && a.model === b.model;
}

/** The research picker's selected option: a chat-list entry's id, or the saved one if it isn't on the list. */
export function researchModelValue(chat: ChainEntry[], research: ChainEntry[] | null): string {
  const current = research?.[0];
  if (!current) return SAME_AS_CHAT;
  return chat.find((entry) => sameModel(entry, current))?.id ?? CURRENT_RESEARCH;
}

/** "Same as chat", then every model on the chat list (main and backups). */
export function researchModelOptions(chat: ChainEntry[], research: ChainEntry[] | null) {
  const current = research?.[0];
  const options = [
    { value: SAME_AS_CHAT, label: "Same as chat" },
    ...chat.filter((entry) => entry.model).map((entry) => ({ value: entry.id, label: `${providerName(entry.provider)} · ${entry.model}` }))
  ];
  if (current && researchModelValue(chat, research) === CURRENT_RESEARCH) {
    options.push({ value: CURRENT_RESEARCH, label: `${providerName(current.provider)} · ${current.model}` });
  }
  return options;
}

export function settingsUrlForTab(href: string, tab: SettingsTab): string {
  const url = new URL(href);
  url.searchParams.set("tab", tab);
  return `${url.pathname}${url.search}${url.hash}`;
}

function initialTab(hosted = isHostedMode()): SettingsTab {
  if (typeof window === "undefined") return hosted ? "market" : "llm";
  return settingsTabFromSearch(window.location.search, hosted);
}

export type CrawlerProbeStatus = "ready" | "checking" | "unavailable";

/**
 * Maps a /api/search/probe crawler response to picker state. One helper for
 * both the mount probe and manual rechecks so the two cannot drift apart.
 * Transport failures stay at the call sites (with their unmount guards).
 */
export function crawlerProbeStateFromResponse(
  httpOk: boolean,
  data: unknown
): { status: CrawlerProbeStatus; reason?: string } {
  const body = (typeof data === "object" && data !== null ? data : {}) as {
    ok?: unknown;
    crawler?: { reason?: unknown };
    message?: unknown;
  };
  if (httpOk && body.ok) return { status: "ready" };
  const reason =
    typeof body.crawler?.reason === "string" && body.crawler.reason
      ? body.crawler.reason
      : typeof body.message === "string"
        ? body.message.replace(/^Unavailable:\s*/, "")
        : "Chromium is missing";
  return { status: "unavailable", reason };
}

interface SettingsLayoutProps {
  activeTab: SettingsTab;
  onSelectTab: (tab: SettingsTab) => void;
  onClose?: () => void;
}

function SettingsLayout({
  activeTab,
  onSelectTab,
  onClose
}: SettingsLayoutProps) {
  const { config, themeCatalog, updateConfig, setTheme } = useApp();
  const [isHosted, setIsHosted] = useState<boolean>(() => isHostedMode());
  const contentRef = useRef<HTMLDivElement>(null);
  // A setting picked from search: revealed once its page has rendered.
  const [pendingJump, setPendingJump] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingJump) return;
    const frame = window.requestAnimationFrame(() => {
      const fallback = SETTING_INDEX.find((entry) => entry.label === pendingJump)?.shownWith;
      if (!revealSetting(contentRef.current, pendingJump) && fallback) revealSetting(contentRef.current, fallback);
      setPendingJump(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingJump, activeTab]);
  const [credentials, setCredentials] = useState<CredentialAvailability | null>(null);
  const [endpointCatalog, setEndpointCatalog] = useState<EndpointCatalogState>({ status: "loading" });
  const [personalityCatalog, setPersonalityCatalog] = useState<PersonalityCatalogState>({ status: "loading" });
  const [exportState, setExportState] = useState<{ busy: boolean; files?: string[]; error?: string }>({ busy: false });
  const [uiKeys, setUiKeys] = useState<KeyMap>({});
  const [hostedSearchKeyDraft, setHostedSearchKeyDraft] = useState("");
  const [hostedSearchRemember, setHostedSearchRemember] = useState(false);
  const [probeState, setProbeState] = useState<{
    busy: boolean;
    status?: "ready" | "checking" | "unavailable";
    message?: string;
    isError?: boolean;
  }>({ busy: false });
  const [crawlerProbeState, setCrawlerProbeState] = useState<{
    busy: boolean;
    status?: "ready" | "checking" | "unavailable";
    reason?: string;
  }>({ busy: false });

  const handleTestSearch = async () => {
    setProbeState({ busy: true, status: "checking" });
    try {
      const provider = config.searchProvider;
      const apiKey = isHosted ? (getByokKey(provider) || undefined) : (uiKeys[provider] || undefined);
      const res = await fetch("/api/search/probe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { [`x-pcbuildsage-api-key-${provider}`]: apiKey } : {})
        },
        body: JSON.stringify({
          provider,
          baseUrl: isHosted ? undefined : config.searchBaseUrl,
          query: "DDR5 RAM",
        })
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setProbeState({
          busy: false,
          status: "ready",
          message: `Works. The test search returned ${data.resultCount ?? 0} results.`,
          isError: false
        });
      } else {
        setProbeState({
          busy: false,
          status: "unavailable",
          message: data.error || "The test search failed.",
          isError: true
        });
      }
    } catch (err) {
      setProbeState({
        busy: false,
        status: "unavailable",
        message: err instanceof Error ? err.message : "Couldn't reach the server. Check your connection and try again.",
        isError: true
      });
    }
  };

  const handleProbeCrawler = useCallback(async (recheck = false) => {
    setCrawlerProbeState({ busy: true, status: "checking" });
    try {
      const res = await fetch("/api/search/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkCrawler: true, recheck })
      });
      const data = await res.json();
      setCrawlerProbeState({ busy: false, ...crawlerProbeStateFromResponse(res.ok, data) });
    } catch (err) {
      setCrawlerProbeState({
        busy: false,
        status: "unavailable",
        reason: err instanceof Error ? err.message : "Network error during probe"
      });
    }
  }, []);

  useEffect(() => {
    if (isHosted) return;
    let ignore = false;
    fetch("/api/search/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checkCrawler: true, recheck: false })
    })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (ignore) return;
        setCrawlerProbeState({ busy: false, ...crawlerProbeStateFromResponse(ok, data) });
      })
      .catch((err) => {
        if (ignore) return;
        setCrawlerProbeState({
          busy: false,
          status: "unavailable",
          reason: err instanceof Error ? err.message : "Network error during probe"
        });
      });
    return () => {
      ignore = true;
    };
  }, [isHosted]);



  const loadEndpoints = useCallback(() => {
    setEndpointCatalog({ status: "loading" });
    fetchEndpoints()
      .then((endpoints) => setEndpointCatalog({ status: "ready", endpoints }))
      .catch((error) => setEndpointCatalog({ status: "error", message: getErrorMessage(error) }));
  }, []);

  const loadPersonalities = useCallback(() => {
    setPersonalityCatalog({ status: "loading" });
    fetchPersonalities()
      .then((personalities) => setPersonalityCatalog({ status: "ready", personalities }))
      .catch((error) => setPersonalityCatalog({ status: "error", message: getErrorMessage(error) }));
  }, []);

  useEffect(() => {
    fetchStatus()
      .then((status) => {
        const mode = status?.deploymentMode ?? status?.mode;
        setIsHosted(mode === "hosted-demo" || isHostedMode());
      })
      .catch(() => {
        setIsHosted(isHostedMode());
      });
  }, []);

  useEffect(() => {
    fetchCredentials().then(setCredentials).catch(() => setCredentials(null));
    fetchEndpoints()
      .then((endpoints) => setEndpointCatalog({ status: "ready", endpoints }))
      .catch((error) => setEndpointCatalog({ status: "error", message: getErrorMessage(error) }));
    fetchPersonalities()
      .then((personalities) => setPersonalityCatalog({ status: "ready", personalities }))
      .catch((error) => setPersonalityCatalog({ status: "error", message: getErrorMessage(error) }));
  }, []);

  const handleKeyChange = (provider: string, value: string) => {
    setUiKeys((prev) => ({ ...prev, [provider]: value }));
    saveUiKey(provider, value);
  };

  const runExport = async () => {
    setExportState({ busy: true });
    try {
      const result = await exportResearch();
      setExportState({ busy: false, files: result.files });
    } catch (error) {
      setExportState({ busy: false, error: getErrorMessage(error) });
    }
  };

  const endpoints = endpointCatalog.status === "ready" ? endpointCatalog.endpoints : [];
  const personalities = personalityCatalog.status === "ready" ? personalityCatalog.personalities : [];
  const themes = themeCatalog.status === "ready" ? themeCatalog.themes : [];

  const navItems = isHosted ? HOSTED_NAV_ITEMS : LOCAL_NAV_ITEMS;
  const activeItem = navItems.find((item) => item.id === activeTab) ?? navItems[0];
  const searchKey = config.searchProvider;
  const searchKeyName = SEARCH_PROVIDER_NAMES[searchKey] ?? searchKey;
  const controlClass = "bg-bg";

  return (
    <div className="flex h-full min-h-0 w-full">
      <SettingsNav
        items={navItems}
        activeTab={activeItem.id}
        onSelectTab={onSelectTab}
        hosted={isHosted}
        onJump={(match) => {
          onSelectTab(match.tab);
          setPendingJump(match.label);
        }}
      />

      <div className="flex min-w-0 flex-1 flex-col bg-bg">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4 sm:px-6">
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm">
            <span className="text-text-secondary">Settings</span>
            <span aria-hidden="true" className="text-text-muted">/</span>
            <h1 className="truncate font-medium text-text">{activeItem.label}</h1>
          </nav>
          {onClose ? (
            <IconButton icon={X} label="Close settings" onClick={onClose} />
          ) : (
            <Link
              href="/"
              className="inline-flex min-h-9 items-center gap-1.5 rounded-btn px-2.5 text-sm text-text-secondary transition-colors duration-150 hover:bg-surface-raised hover:text-text"
            >
              <Icon icon={ArrowLeft} size={15} />
              Back to chat
            </Link>
          )}
        </header>

        {/* Phones get the pages as a scrolling strip instead of the side nav. */}
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 py-2 scrollbar-none md:hidden">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={item.id === activeItem.id ? "page" : undefined}
              onClick={() => onSelectTab(item.id)}
              className={cn(
                "inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-btn px-3 text-sm transition-colors duration-150",
                item.id === activeItem.id
                  ? "bg-surface-raised font-medium text-text"
                  : "text-text-secondary hover:bg-surface-raised hover:text-text"
              )}
            >
              <Icon icon={item.icon} size={15} />
              {item.label}
            </button>
          ))}
        </div>

        <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className={cn("mx-auto flex w-full flex-col gap-10 px-4 py-6 sm:px-8 sm:py-8", activeItem.id === "providers" ? "max-w-5xl" : "max-w-3xl")}>
            {activeItem.id === "market" && <MarketPreferenceSection />}

            {activeItem.id === "llm" &&
              (isHosted ? (
                <ByokSection
                  onModelChange={(provider, model, contextLimit) => {
                    updateConfig((prev) => ({
                      ...prev,
                      chatChain: [
                        {
                          id: `hosted-${provider}`,
                          provider: provider as LLMProvider,
                          model,
                          keySource: "ui",
                          ...(contextLimit ? { contextLimit } : {})
                        }
                      ]
                    }));
                  }}
                />
              ) : (
                <section className="flex flex-col gap-3" data-setting="Chat models">
                  <div className="flex flex-col gap-1 px-1">
                    <h2 className="type-title text-lg text-text">Chat models</h2>
                    <p className="text-sm text-text-secondary">
                      The main model answers your chats. If it fails, the backup models take over in order.
                    </p>
                  </div>
                  <CatalogNotice
                    status={endpointCatalog.status}
                    error={endpointCatalog.status === "error" ? endpointCatalog.message : undefined}
                    empty={endpointCatalog.status === "ready" && endpointCatalog.endpoints.length === 0}
                    loadingText="Loading saved servers…"
                    errorTitle="Couldn't load saved servers"
                    emptyText="No saved servers are set up. You can still type a server address."
                    onRetry={loadEndpoints}
                  />
                  <ChainBuilder
                    chain={config.chatChain}
                    onChange={(chatChain) => updateConfig({ chatChain })}
                    endpoints={endpoints}
                    credentials={credentials}
                  />
                </section>
              ))}

            {activeItem.id === "providers" && (
              <ProvidersPage
                chain={config.chatChain}
                onChange={(chatChain) => updateConfig({ chatChain })}
                credentials={credentials}
              />
            )}

            {activeItem.id === "search" && (
              <SettingsGroup
                title="Web search"
                description="Lets the Sage search the web for part specs it doesn't have. Optional."
              >
                <SettingsRow title="Search with" description="Where the Sage searches.">
                  {(controlProps) => (
                    <Select
                      {...controlProps}
                      className={controlClass}
                      value={config.searchProvider}
                      onChange={(e) => {
                        const provider = e.target.value as SearchProvider;
                        updateConfig({
                          searchProvider: provider,
                          ...(isHosted ? { tier2Enabled: provider !== "none" } : {})
                        });
                      }}
                      options={
                        isHosted
                          ? [
                              { value: "none", label: "Off" },
                              { value: "tavily", label: "Tavily" },
                              { value: "exa", label: "Exa" },
                              { value: "brave", label: "Brave Search" }
                            ]
                          : [
                              { value: "none", label: "Off" },
                              { value: "searxng", label: "SearXNG (self-hosted)" },
                              { value: "brave", label: "Brave Search" },
                              { value: "tavily", label: "Tavily" },
                              { value: "exa", label: "Exa" },
                              { value: "gemini-native", label: "Google Search through Gemini" }
                            ]
                      }
                    />
                  )}
                </SettingsRow>

                {!isHosted && config.searchProvider === "searxng" && (
                  <SettingsRow title="SearXNG address" description="For example http://localhost:8888">
                    {(controlProps) => (
                      <Input
                        {...controlProps}
                        mono
                        className={controlClass}
                        type="text"
                        placeholder="http://localhost:8888"
                        value={config.searchBaseUrl || ""}
                        onChange={(e) => updateConfig({ searchBaseUrl: e.target.value || undefined })}
                      />
                    )}
                  </SettingsRow>
                )}

                {isHosted && ["brave", "tavily", "exa"].includes(searchKey) && (
                  <SettingsRow
                    stacked
                    title={`${searchKeyName} API key`}
                    description={
                      isByokKeyPersistent(searchKey)
                        ? `Your key is kept in this browser's local storage until you clear it. ${KEY_HANDLING_SENTENCES.slice(1).join(" ")}`
                        : KEY_HANDLING_SENTENCES.join(" ")
                    }
                  >
                    {(controlProps) => (
                      <div className="flex flex-col gap-2">
                        <div className="flex gap-2">
                          <Input
                            {...controlProps}
                            className={controlClass}
                            type="password"
                            placeholder={getByokKey(searchKey) ? "••••••••••••••••" : `Paste your ${searchKeyName} key`}
                            value={hostedSearchKeyDraft}
                            onChange={(e) => setHostedSearchKeyDraft(e.target.value)}
                          />
                          <Button
                            variant="ghost"
                            onClick={() => {
                              if (hostedSearchKeyDraft.trim()) {
                                setByokKey(searchKey, hostedSearchKeyDraft.trim(), hostedSearchRemember);
                                setHostedSearchKeyDraft("");
                                updateConfig({ tier2Enabled: true });
                              }
                            }}
                            disabled={!hostedSearchKeyDraft.trim()}
                          >
                            Save key
                          </Button>
                          {getByokKey(searchKey) && (
                            <Button
                              variant="ghost"
                              onClick={() => {
                                clearByokKey(searchKey);
                                setHostedSearchKeyDraft("");
                                updateConfig({ tier2Enabled: false });
                              }}
                            >
                              Clear key
                            </Button>
                          )}
                        </div>
                        <label className="flex cursor-pointer items-center gap-2 text-caption text-text-secondary">
                          <input
                            type="checkbox"
                            checked={hostedSearchRemember}
                            onChange={(e) => setHostedSearchRemember(e.target.checked)}
                            className="accent-[var(--accent)]"
                          />
                          <span>Remember for this browser</span>
                        </label>
                      </div>
                    )}
                  </SettingsRow>
                )}

                {!isHosted && ["brave", "tavily", "exa"].includes(searchKey) && (
                  <SettingsRow
                    stacked
                    title={`${searchKeyName} API key`}
                    description="Stored in this browser's local storage. Sent with each request only so the PCBuildSage server can forward it to this provider."
                  >
                    {(controlProps) => (
                      <Input
                        {...controlProps}
                        className={controlClass}
                        type="password"
                        placeholder="Paste your key"
                        value={uiKeys[searchKey] || ""}
                        onChange={(e) => handleKeyChange(searchKey, e.target.value)}
                      />
                    )}
                  </SettingsRow>
                )}

                {!isHosted && !["none", "gemini-native"].includes(searchKey) && (
                  <>
                    <SettingsToggleRow
                      checked={config.crawlEnabled}
                      onChange={(value) => updateConfig({ crawlEnabled: value })}
                      label="Read the top result"
                      description="Opens the top search result and pulls out its main text for more detail. Uses Crawl4AI."
                    />
                    <SettingsActionRow
                      title="Page reader"
                      description={
                        crawlerProbeState.busy
                          ? "Checking…"
                          : crawlerProbeState.status === "ready"
                            ? "Ready."
                            : crawlerProbeState.status === "unavailable"
                              ? `Unavailable: ${crawlerProbeState.reason || "Chromium is missing"}. Web search still works.`
                              : "Checks that Crawl4AI can open pages."
                      }
                    >
                      <Button
                        variant="ghost"
                        disabled={crawlerProbeState.busy}
                        onClick={() => handleProbeCrawler(true)}
                      >
                        {crawlerProbeState.busy ? "Checking…" : "Check page reader"}
                      </Button>
                    </SettingsActionRow>
                  </>
                )}

                {config.searchProvider !== "none" && (
                  <SettingsRow
                    title="Research model"
                    description="Same as chat, or any model on your chat list. A model from another provider keeps research off your chat model's usage limits."
                  >
                    {(controlProps) => (
                      <Select
                        {...controlProps}
                        className={controlClass}
                        value={researchModelValue(config.chatChain, config.subagentChain)}
                        onChange={(e) => {
                          if (e.target.value === CURRENT_RESEARCH) return;
                          const picked = config.chatChain.find((entry) => entry.id === e.target.value);
                          updateConfig({
                            subagentChain: picked ? [{ ...picked, id: `subagent-${picked.id}`, ping: undefined }] : []
                          });
                        }}
                        options={researchModelOptions(config.chatChain, config.subagentChain)}
                      />
                    )}
                  </SettingsRow>
                )}

                {config.searchProvider !== "none" && (
                  <SettingsActionRow
                    title="Test search"
                    description="Runs one search to check the provider and key. No AI model is used."
                    footer={
                      !probeState.busy && probeState.message ? (
                        <p role="status" className={cn("text-caption", probeState.isError ? "text-warn" : "text-ok")}>
                          {probeState.message}
                        </p>
                      ) : null
                    }
                  >
                    <Button variant="ghost" disabled={probeState.busy} onClick={handleTestSearch}>
                      {probeState.busy ? "Searching…" : probeState.status ? "Test again" : "Test search"}
                    </Button>
                  </SettingsActionRow>
                )}
              </SettingsGroup>
            )}

            {activeItem.id === "personalization" && (
              <>
                {!isHosted && <MarketPreferenceSection />}
                <SettingsGroup title="Appearance">
                  <SettingsRow title="Theme" description="Colours for the whole app. They change right away.">
                    {(controlProps) =>
                      themeCatalog.status === "ready" && themes.length > 0 ? (
                        <Select
                          {...controlProps}
                          className={controlClass}
                          value={config.theme}
                          onChange={(e) => setTheme(e.target.value)}
                          options={themes.map((theme) => {
                            const name = theme.theme_name ?? theme.id;
                            return { value: name, label: themeLabel(name) };
                          })}
                        />
                      ) : (
                        <CatalogNotice
                          status={themeCatalog.status}
                          error={themeCatalog.status === "error" ? themeCatalog.message : undefined}
                          empty={themeCatalog.status === "ready" && themeCatalog.themes.length === 0}
                          loadingText="Loading themes…"
                          errorTitle="Couldn't load themes"
                          emptyText="No themes are installed. The built-in Sage dark colors stay on."
                        />
                      )
                    }
                  </SettingsRow>
                </SettingsGroup>

                <SettingsGroup title="Tone" description="How the Sage talks to you.">
                  {personalityCatalog.status === "ready" && personalities.length > 0 ? (
                    <ChoiceGroup label="Tone" legendClassName="sr-only" className="divide-y divide-border">
                      {personalities.map((personality) => {
                        const active = config.personality === personality.id;
                        return (
                          <ChoiceControl
                            key={personality.id}
                            type="radio"
                            name="personality"
                            value={personality.id}
                            checked={active}
                            onChange={() => updateConfig({ personality: personality.id })}
                            className={cn(
                              "flex items-center gap-4 px-4 py-3.5 text-left transition-colors duration-150 focus-within:-outline-offset-2",
                              active ? "bg-accent/10" : "hover:bg-surface-raised"
                            )}
                          >
                            <span className="flex flex-1 flex-col gap-0.5">
                              <span className="text-sm font-medium text-text">{personality.name}</span>
                              <span className="text-caption text-text-secondary">{personality.description}</span>
                            </span>
                            <span
                              aria-hidden="true"
                              className={cn(
                                "flex h-5 w-5 shrink-0 items-center justify-center rounded-pill border",
                                active ? "border-accent bg-accent text-on-accent" : "border-border"
                              )}
                            >
                              {active ? <Icon icon={Check} size={12} /> : null}
                            </span>
                          </ChoiceControl>
                        );
                      })}
                    </ChoiceGroup>
                  ) : (
                    <div className="px-4 py-3.5">
                      <CatalogNotice
                        status={personalityCatalog.status}
                        error={personalityCatalog.status === "error" ? personalityCatalog.message : undefined}
                        empty={personalityCatalog.status === "ready" && personalityCatalog.personalities.length === 0}
                        loadingText="Loading tones…"
                        errorTitle="Couldn't load tones"
                        emptyText="No tones are installed."
                        onRetry={loadPersonalities}
                      />
                    </div>
                  )}
                </SettingsGroup>
              </>
            )}

            {activeItem.id === "database" && !isHosted && (
              <>
                <SettingsGroup
                  title="Spec research"
                  description="Lets the Sage look up specs the catalog is missing. Research only advises; it never overrides a compatibility block."
                >
                  <SettingsToggleRow
                    checked={config.tier2Enabled}
                    onChange={(value) => updateConfig({ tier2Enabled: value })}
                    label="Research missing specs"
                    description="Looks up unknown specs and runs an advisory check of the build."
                  />
                  <SettingsToggleRow
                    checked={config.auditVisible}
                    onChange={(value) => updateConfig({ auditVisible: value })}
                    label="Show research in chat"
                    description="Shows research steps and check notes in the conversation."
                    disabled={!config.tier2Enabled}
                  />
                  <SettingsToggleRow
                    checked={config.freeformConsultEnabled}
                    onChange={(value) => updateConfig({ freeformConsultEnabled: value })}
                    label="Answer open questions"
                    description="Lets you ask sourced spec questions outside a build."
                    disabled={!config.tier2Enabled}
                  />
                </SettingsGroup>

                <SettingsGroup title="Catalog">
                  <SettingsActionRow
                    title="Share researched specs"
                    description="Exports the specs research found so they can be added to the shared catalog."
                    footer={
                      exportState.files ? (
                        exportState.files.length ? (
                          <ul className="font-mono text-caption text-text-secondary">
                            {exportState.files.map((file) => (
                              <li key={file}>{file}</li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-caption text-text-secondary">No researched specs to export yet.</p>
                        )
                      ) : exportState.error ? (
                        <p className="text-caption text-warn">{exportState.error}</p>
                      ) : null
                    }
                  >
                    <Button variant="ghost" iconLeft={Download} loading={exportState.busy} onClick={runExport}>
                      Export
                    </Button>
                  </SettingsActionRow>
                  <SettingsActionRow
                    title="Product catalog"
                    description="Set up the local product database and scrape retailer listings."
                  >
                    <Button
                      variant="ghost"
                      iconLeft={Wand2}
                      onClick={() => {
                        updateConfig({ onboarded: false });
                        openSetup();
                      }}
                    >
                      Open catalog setup
                    </Button>
                  </SettingsActionRow>
                </SettingsGroup>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The settings pages list, as in T3 Code: a search box ("/" focuses it) over
 * grouped pages. Typing filters pages by name and by what they contain; Enter
 * opens the first match. Hidden on phones, where a strip under the header
 * lists the pages instead.
 */
function SettingsNav({
  items,
  activeTab,
  onSelectTab,
  hosted,
  onJump
}: {
  items: SettingsNavItem[];
  activeTab: SettingsTab;
  onSelectTab: (tab: SettingsTab) => void;
  hosted: boolean;
  onJump: (match: SettingMatch) => void;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const matches = findSettingsPages(items, query);
  const settingMatches = findSettings(query, hosted);

  return (
    <aside className="hidden w-60 shrink-0 flex-col gap-4 border-r border-border bg-surface p-3 md:flex">
      <div className="field-box flex h-9 items-center gap-2 rounded-btn border border-border bg-bg px-2.5">
        <Icon icon={Search} size={15} className="shrink-0 text-text-muted" />
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            if (settingMatches[0]) onJump(settingMatches[0]);
            else if (matches[0]) onSelectTab(matches[0].id);
          }}
          placeholder="Search"
          aria-label="Search settings"
          className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-muted [&::-webkit-search-cancel-button]:hidden"
        />
        <kbd className="rounded-chip border border-border px-1.5 font-mono text-[11px] leading-5 text-text-muted">/</kbd>
      </div>

      <nav aria-label="Settings pages" className="flex flex-col gap-4 overflow-y-auto">
        {settingMatches.length > 0 ? (
          <div className="flex flex-col gap-0.5" data-testid="setting-matches">
            <p className="type-label px-2.5 pb-1 text-caption text-text-muted">Settings</p>
            {settingMatches.map((match) => (
              <button
                key={`${match.tab}-${match.label}`}
                type="button"
                onClick={() => onJump(match)}
                className="flex flex-col items-start rounded-btn px-2.5 py-1.5 text-left transition-colors duration-150 hover:bg-surface-raised"
              >
                <span className="text-sm text-text">{match.label}</span>
                <span className="text-caption text-text-muted">{items.find((item) => item.id === match.tab)?.label}</span>
              </button>
            ))}
          </div>
        ) : null}
        {matches.length === 0 && settingMatches.length === 0 ? (
          <p className="px-2.5 text-caption text-text-muted">No settings match “{query.trim()}”.</p>
        ) : matches.length === 0 ? null : (
          NAV_GROUPS.map((group) => {
            const groupItems = matches.filter((item) => item.group === group);
            if (groupItems.length === 0) return null;
            return (
              <div key={group} className="flex flex-col gap-0.5">
                <p className="type-label px-2.5 pb-1 text-caption text-text-muted">{group}</p>
                {groupItems.map((item) => {
                  const active = item.id === activeTab;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-current={active ? "page" : undefined}
                      onClick={() => onSelectTab(item.id)}
                      className={cn(
                        "flex min-h-9 items-center gap-2.5 rounded-btn px-2.5 text-left text-sm transition-colors duration-150",
                        active
                          ? "bg-surface-raised font-medium text-text"
                          : "text-text-secondary hover:bg-surface-raised hover:text-text"
                      )}
                    >
                      <Icon icon={item.icon} size={16} className={active ? "text-accent" : undefined} />
                      {item.label}
                    </button>
                  );
                })}
              </div>
            );
          })
        )}
      </nav>

      <p className="mt-auto px-2.5 text-caption text-text-muted">Changes save as you make them.</p>
    </aside>
  );
}

export function SettingsView({
  isModal = false,
  initialTabProp,
  onClose
}: {
  isModal?: boolean;
  initialTabProp?: SettingsTab;
  onClose?: () => void;
} = {}) {
  const hosted = isHostedMode();
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    if (initialTabProp) {
      if (hosted && initialTabProp === "database") return "market";
      return initialTabProp;
    }
    return initialTab(hosted);
  });

  useEffect(() => {
    if (isModal) return;
    const syncFromUrl = () => setActiveTab(settingsTabFromSearch(window.location.search, isHostedMode()));
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, [isModal]);

  const selectTab = (tab: SettingsTab) => {
    if (tab === activeTab) return;
    if (!isModal) {
      window.history.pushState(null, "", settingsUrlForTab(window.location.href, tab));
    }
    setActiveTab(tab);
  };

  return (
    <div className={cn("flex overflow-hidden bg-bg text-text", isModal ? "h-full w-full" : "h-dvh")}>
      <SettingsLayout activeTab={activeTab} onSelectTab={selectTab} onClose={onClose} />
    </div>
  );
}

function CatalogNotice({
  status,
  error,
  empty,
  loadingText,
  errorTitle,
  emptyText,
  onRetry
}: {
  status: "loading" | "error" | "ready";
  error?: string;
  empty: boolean;
  loadingText: string;
  errorTitle: string;
  emptyText: string;
  onRetry?: () => void;
}) {
  if (status === "ready" && !empty) return null;
  if (status === "loading") {
    return <p className="text-caption text-text-muted" aria-live="polite">{loadingText}</p>;
  }
  if (status === "error") {
    return (
      <div className="flex items-start justify-between gap-3 rounded-card border border-border bg-surface p-3" role="alert">
        <div>
          <p className="text-caption font-medium text-warn">{errorTitle}</p>
          {error ? <p className="text-caption text-text-secondary">{error}</p> : null}
        </div>
        {onRetry ? <Button variant="ghost" size="sm" onClick={onRetry}>Try again</Button> : null}
      </div>
    );
  }
  return <p className="text-caption text-text-muted">{emptyText}</p>;
}
