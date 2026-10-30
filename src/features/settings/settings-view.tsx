"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Database, Download, Globe, Moon, Search, Sliders, Sparkles, Sun, Wand2, X } from "lucide-react";
import { useApp } from "@/components/app/app-provider";
import {
  exportResearch,
  fetchCredentials,
  fetchEndpoints,
  fetchPersonalities,
  fetchStatus,
  isHostedMode
} from "@/lib/api-client";
import type { CredentialAvailability, EndpointPreset, LLMProvider, Personality, SearchProvider } from "@/types/client";
import { saveUiKey, type KeyMap } from "@/lib/client-config-store";
import { getErrorMessage } from "@/lib/format";
import { ChainBuilder } from "@/features/llm/chain-builder";
import { MarketPreferenceSection } from "./market-preference-section";
import { ByokSection } from "./byok-section";
import { KEY_HANDLING_SENTENCES } from "./key-help-panel";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icon";
import { Button, ChoiceControl, ChoiceGroup, Toggle, Input, Field, IconButton } from "@/components/ui/primitives";
import { Select } from "@/components/ui/select";
import { LeafMark, Wordmark } from "@/components/app/brand";
import { ThemeSwitcher } from "@/components/app/theme-switcher";
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarTrigger,
  SidebarFooter,
  SidebarRail
} from "@/components/animate-ui/components/radix/sidebar";

// Neutral hover for the base shadcn Button (ghost) used by SidebarTrigger:
// twMerge lets this override the component's default `hover:bg-accent` (green).
const TRIGGER_HOVER = "hover:bg-surface-raised hover:text-text";

export type SettingsTab = "market" | "llm" | "search" | "personalization" | "database";
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

// Tab ids are URL values (?tab=…) and stay fixed; only the labels are user-facing.
export const LOCAL_NAV_ITEMS: { id: SettingsTab; label: string; icon: typeof Sparkles }[] = [
  { id: "llm", label: "AI model", icon: Sparkles },
  { id: "search", label: "Web research", icon: Search },
  { id: "personalization", label: "Look and tone", icon: Sliders },
  { id: "database", label: "Catalog", icon: Database }
];

export const HOSTED_NAV_ITEMS: { id: SettingsTab; label: string; icon: typeof Sparkles }[] = [
  { id: "market", label: "Region and currency", icon: Globe },
  { id: "llm", label: "AI model", icon: Sparkles },
  { id: "search", label: "Web research", icon: Search },
  { id: "personalization", label: "Look and tone", icon: Sliders }
];

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
  if (requested === "market") return "market";
  if (requested === "byok") return "llm";
  const items = hosted ? HOSTED_NAV_ITEMS : LOCAL_NAV_ITEMS;
  return items.some((item) => item.id === requested) ? (requested as SettingsTab) : (hosted ? "market" : "llm");
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

  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader className="h-14 flex-row items-center justify-between border-b border-border px-2">
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="flex items-center gap-2 rounded-btn px-1 cursor-pointer text-left"
              aria-label="PCBuildSage home"
            >
              <LeafMark size={22} />
              <Wordmark className="text-base group-data-[collapsible=icon]:hidden" />
            </button>
          ) : (
            <Link
              href="/"
              className="flex items-center gap-2 rounded-btn px-1"
              aria-label="PCBuildSage home"
            >
              <LeafMark size={22} />
              <Wordmark className="text-base group-data-[collapsible=icon]:hidden" />
            </Link>
          )}
          <SidebarTrigger className={cn("group-data-[collapsible=icon]:hidden", TRIGGER_HOVER)} />
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Settings</SidebarGroupLabel>
            <SidebarMenu>
              {(isHosted ? HOSTED_NAV_ITEMS : LOCAL_NAV_ITEMS).map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    isActive={activeTab === item.id}
                    onClick={() => onSelectTab(item.id)}
                    tooltip={item.label}
                  >
                    <Icon icon={item.icon} size={16} />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="border-t border-border">
          <SidebarMenu>
            <SidebarMenuItem>
              {onClose ? (
                <SidebarMenuButton tooltip="Back to chat" onClick={onClose}>
                  <Icon icon={ArrowLeft} size={16} />
                  <span>Back to chat</span>
                </SidebarMenuButton>
              ) : (
                <SidebarMenuButton asChild tooltip="Back to chat">
                  <Link href="/">
                    <Icon icon={ArrowLeft} size={16} />
                    <span>Back to chat</span>
                  </Link>
                </SidebarMenuButton>
              )}
            </SidebarMenuItem>
            <SidebarMenuItem>
              <ThemeSwitcher variant="sidebar" />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      {/* Main Settings Content */}
      <div className="flex h-full min-w-0 flex-1 flex-col bg-bg overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-bg px-4 sm:px-8">
          <div className="flex min-w-0 items-center gap-3">
            {/* Mobile-only opener: on phones the sidebar collapses to a Sheet
                whose own trigger is hidden, so surface one in the header. */}
            <SidebarTrigger className={cn("md:hidden", TRIGGER_HOVER)} />
            <div className="flex min-w-0 items-baseline gap-3">
              <h1 className="type-title text-xl text-text">Settings</h1>
              <p className="hidden truncate text-caption text-text-muted sm:block">Most changes save as you make them.</p>
            </div>
          </div>
          {onClose ? (
            <IconButton icon={X} label="Close settings" onClick={onClose} />
          ) : null}
        </header>

        <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-4 py-8 sm:px-8 scrollbar-none">
          {activeTab === "market" && (
            <MarketPreferenceSection />
          )}

          {activeTab === "llm" && (
            <div className="flex flex-col gap-8">
              {isHosted ? (
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
                <Section
                  title="AI model"
                  description="The main model answers your chats. If it fails, the backup models take over in order."
                >
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
                </Section>
              )}
            </div>
          )}

          {activeTab === "search" && (
            <Section
              title="Web research"
              description="Lets the Sage search the web for part specs it doesn't have. Optional."
            >
              <div className="flex flex-col gap-4 rounded-card border border-border bg-surface p-4">
                <Field label="Search with">
                  {(controlProps) => (
                    <Select
                      {...controlProps}
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
                              { value: "duckduckgo", label: "DuckDuckGo (no key needed)" },
                              { value: "searxng", label: "SearXNG (self-hosted)" },
                              { value: "brave", label: "Brave Search" },
                              { value: "tavily", label: "Tavily" },
                              { value: "exa", label: "Exa" },
                              { value: "gemini-native", label: "Google Search through Gemini" }
                            ]
                      }
                    />
                  )}
                </Field>

                {!isHosted && config.searchProvider === "searxng" && (
                  <Field label="SearXNG address" hint="For example http://localhost:8888">
                    {(controlProps) => (
                      <Input
                        {...controlProps}
                        type="text"
                        placeholder="http://localhost:8888"
                        value={config.searchBaseUrl || ""}
                        onChange={(e) => updateConfig({ searchBaseUrl: e.target.value || undefined })}
                      />
                    )}
                  </Field>
                )}

                {isHosted && ["brave", "tavily", "exa"].includes(config.searchProvider) && (
                  <div className="flex flex-col gap-3 border-t border-border pt-4">
                    <Field
                      label={`${SEARCH_PROVIDER_NAMES[config.searchProvider] ?? config.searchProvider} API key`}
                      hint={
                        isByokKeyPersistent(config.searchProvider)
                          ? `Your key is kept in this browser's local storage until you clear it. ${KEY_HANDLING_SENTENCES.slice(1).join(" ")}`
                          : KEY_HANDLING_SENTENCES.join(" ")
                      }
                    >
                      {(controlProps) => (
                        <div className="flex flex-col gap-2">
                          <div className="flex gap-2">
                            <Input
                              {...controlProps}
                              type="password"
                              placeholder={
                                getByokKey(config.searchProvider)
                                  ? "••••••••••••••••"
                                  : `Paste your ${SEARCH_PROVIDER_NAMES[config.searchProvider] ?? config.searchProvider} key`
                              }
                              value={hostedSearchKeyDraft}
                              onChange={(e) => setHostedSearchKeyDraft(e.target.value)}
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                if (hostedSearchKeyDraft.trim()) {
                                  setByokKey(
                                    config.searchProvider,
                                    hostedSearchKeyDraft.trim(),
                                    hostedSearchRemember
                                  );
                                  setHostedSearchKeyDraft("");
                                  updateConfig({ tier2Enabled: true });
                                }
                              }}
                              disabled={!hostedSearchKeyDraft.trim()}
                            >
                              Save key
                            </Button>
                            {getByokKey(config.searchProvider) && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  clearByokKey(config.searchProvider);
                                  setHostedSearchKeyDraft("");
                                  updateConfig({ tier2Enabled: false });
                                }}
                              >
                                Clear key
                              </Button>
                            )}
                          </div>
                          <label className="flex items-center gap-2 text-caption text-text-secondary cursor-pointer">
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
                    </Field>
                  </div>
                )}

                {!isHosted && ["brave", "tavily", "exa"].includes(config.searchProvider) && (
                  <Field
                    label={`${SEARCH_PROVIDER_NAMES[config.searchProvider] ?? config.searchProvider} API key`}
                    hint="Stored in this browser's local storage. Sent with each request only so the PCBuildSage server can forward it to this provider."
                  >
                    {(controlProps) => (
                      <Input
                        {...controlProps}
                        type="password"
                        placeholder="Paste your key"
                        value={uiKeys[config.searchProvider] || ""}
                        onChange={(e) => handleKeyChange(config.searchProvider, e.target.value)}
                      />
                    )}
                  </Field>
                )}

                {!isHosted && !["none", "gemini-native"].includes(config.searchProvider) && (
                  <div className="flex flex-col gap-2">
                    <Toggle
                      checked={config.crawlEnabled}
                      onChange={(value) => updateConfig({ crawlEnabled: value })}
                      label="Read the top result"
                      description="Opens the top search result and pulls out its main text for more detail. Uses Crawl4AI."
                    />
                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={crawlerProbeState.busy}
                        onClick={() => handleProbeCrawler(true)}
                      >
                        {crawlerProbeState.busy ? "Checking…" : "Check page reader"}
                      </Button>
                      {!crawlerProbeState.busy && crawlerProbeState.status === "ready" && (
                        <span className="inline-flex items-center gap-1 text-caption text-ok">
                          <Icon icon={Check} size={13} />
                          Page reader ready
                        </span>
                      )}
                    </div>
                    {!crawlerProbeState.busy && crawlerProbeState.status === "unavailable" && (
                      <p className="text-caption text-warn">
                        Page reader unavailable: {crawlerProbeState.reason || "Chromium is missing"}. Web search still works.
                      </p>
                    )}
                  </div>
                )}

                {config.searchProvider !== "none" && (
                  <Field
                    label="Research model"
                    hint="“Same as chat” shares your chat model's usage limits."
                  >
                    {(controlProps) => (
                      <Select
                        {...controlProps}
                        value={config.subagentChain && config.subagentChain.length > 0 ? config.subagentChain[0].model : "same-as-chat"}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === "same-as-chat") {
                            updateConfig({ subagentChain: [] });
                          } else {
                            const chatEntry = config.chatChain[0];
                            if (!chatEntry) return;
                            updateConfig({
                              subagentChain: [
                                {
                                  ...chatEntry,
                                  id: `subagent-${val}`,
                                  model: val
                                }
                              ]
                            });
                          }
                        }}
                        options={[
                          { value: "same-as-chat", label: "Same as chat" },
                          ...(config.chatChain?.[0]?.model
                            ? [{ value: config.chatChain[0].model, label: `${config.chatChain[0].model} (your chat model)` }]
                            : [])
                        ]}
                      />
                    )}
                  </Field>
                )}

                {config.searchProvider !== "none" && (
                  <div className="flex flex-col gap-2 border-t border-border pt-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={probeState.busy}
                        onClick={handleTestSearch}
                      >
                        {probeState.busy ? "Searching…" : probeState.status ? "Test again" : "Test search"}
                      </Button>
                      {!probeState.busy && probeState.message && (
                        <span
                          className={`text-caption ${probeState.isError ? "text-warn" : "text-ok"}`}
                        >
                          {probeState.message}
                        </span>
                      )}
                    </div>
                    <p className="text-caption text-text-muted">
                      Runs one search to check the provider and key. No AI model is used.
                    </p>
                  </div>
                )}
              </div>
            </Section>
          )}

          {activeTab === "personalization" && (
            <div className="flex flex-col gap-10">
              {!isHosted && <MarketPreferenceSection />}
              <Section title="Theme" description="Pick the colors. They change right away.">
                <CatalogNotice
                  status={themeCatalog.status}
                  error={themeCatalog.status === "error" ? themeCatalog.message : undefined}
                  empty={themeCatalog.status === "ready" && themeCatalog.themes.length === 0}
                  loadingText="Loading themes…"
                  errorTitle="Couldn't load themes"
                  emptyText="No themes are installed. The built-in sage-dark colors stay on."
                />
                {themeCatalog.status === "ready" && themes.length > 0 ? (
                  <ChoiceGroup label="Theme" legendClassName="sr-only" className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
                    {themes.map((theme) => {
                    const name = theme.theme_name ?? theme.id;
                    const active = name === config.theme;
                    return (
                      <ChoiceControl
                        key={theme.id}
                        type="radio"
                        name="theme"
                        value={name}
                        checked={active}
                        onChange={() => setTheme(name)}
                        className={cn(
                          "flex min-h-12 items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 cursor-pointer",
                          active ? "bg-accent/10" : "hover:bg-surface-raised"
                        )}
                      >
                        <Icon icon={theme.mode === "light" ? Sun : Moon} size={16} className="text-text-secondary" />
                        <span className={cn("flex-1 text-sm", active ? "font-medium text-text" : "text-text")}>{name}</span>
                        <ThemeSwatch tokens={theme.tokens} />
                        {active ? <Icon icon={Check} size={15} className="text-accent" /> : null}
                      </ChoiceControl>
                    );
                    })}
                  </ChoiceGroup>
                ) : null}
              </Section>

              <Section title="Tone" description="How the Sage talks to you.">
                <CatalogNotice
                  status={personalityCatalog.status}
                  error={personalityCatalog.status === "error" ? personalityCatalog.message : undefined}
                  empty={personalityCatalog.status === "ready" && personalityCatalog.personalities.length === 0}
                  loadingText="Loading tones…"
                  errorTitle="Couldn't load tones"
                  emptyText="No tones are installed."
                  onRetry={loadPersonalities}
                />
                {personalityCatalog.status === "ready" && personalities.length > 0 ? (
                  <ChoiceGroup label="Tone" legendClassName="sr-only" className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
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
                          "flex items-start gap-3 px-4 py-3 text-left transition-colors duration-150 cursor-pointer",
                          active ? "bg-accent/10" : "hover:bg-surface-raised"
                        )}
                      >
                        <span className="flex flex-1 flex-col gap-0.5">
                          <span className="text-sm font-medium text-text">{personality.name}</span>
                          <span className="text-caption text-text-secondary">{personality.description}</span>
                        </span>
                        {active ? <Icon icon={Check} size={15} className="mt-0.5 text-accent" /> : null}
                      </ChoiceControl>
                    );
                    })}
                  </ChoiceGroup>
                ) : null}
              </Section>
            </div>
          )}

          {activeTab === "database" && !isHosted && (
            <div className="flex flex-col gap-10">
              <Section title="Spec research" description="Lets the Sage look up specs the catalog is missing. Research only advises; it never overrides a compatibility block.">
                <div className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface [&>*]:px-4 [&>*]:py-3.5">
                  <Toggle
                    checked={config.tier2Enabled}
                    onChange={(value) => updateConfig({ tier2Enabled: value })}
                    label="Research missing specs"
                    description="Looks up unknown specs and runs an advisory check of the build."
                  />
                  <Toggle
                    checked={config.auditVisible}
                    onChange={(value) => updateConfig({ auditVisible: value })}
                    label="Show research in chat"
                    description="Shows research steps and check notes in the conversation."
                    disabled={!config.tier2Enabled}
                  />
                  <Toggle
                    checked={config.freeformConsultEnabled}
                    onChange={(value) => updateConfig({ freeformConsultEnabled: value })}
                    label="Answer open questions"
                    description="Lets you ask sourced spec questions outside a build."
                    disabled={!config.tier2Enabled}
                  />
                </div>
              </Section>

              <Section title="Share researched specs" description="Export the specs research found so they can be added to the shared catalog.">
                <div className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4">
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-sm text-text">Researched specs</span>
                    <Button variant="ghost" iconLeft={Download} loading={exportState.busy} onClick={runExport}>
                      Export
                    </Button>
                  </div>
                  {exportState.files ? (
                    exportState.files.length ? (
                      <ul className="border-t border-border pt-3 font-mono text-caption text-text-secondary">
                        {exportState.files.map((file) => <li key={file}>{file}</li>)}
                      </ul>
                    ) : (
                      <p className="border-t border-border pt-3 text-caption text-text-secondary">No researched specs to export yet.</p>
                    )
                  ) : null}
                  {exportState.error ? (
                    <p className="border-t border-border pt-3 text-caption text-warn">
                      {exportState.error}
                    </p>
                  ) : null}
                </div>
              </Section>

              <Section title="Product catalog" description="Set up the local product database and scrape retailer listings.">
                <Button
                  variant="ghost"
                  iconLeft={Wand2}
                  onClick={() => updateConfig({ onboarded: false })}
                  className="self-start"
                >
                  Open catalog setup
                </Button>
              </Section>
            </div>
          )}
        </div>
      </div>
    </>
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
    <SidebarProvider defaultOpen className={cn("overflow-hidden bg-bg text-text", isModal ? "h-full w-full" : "h-dvh")}>
      <SettingsLayout activeTab={activeTab} onSelectTab={selectTab} onClose={onClose} />
    </SidebarProvider>
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

/** One settings section: a type-title heading, a one-line description, then its controls. */
function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="type-title text-xl text-text">{title}</h2>
        {description ? <p className="text-sm text-text-secondary">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function ThemeSwatch({ tokens }: { tokens: Record<string, string> }) {
  const keys = ["--bg", "--surface", "--accent", "--warn", "--unverified"];
  return (
    <span className="flex items-center gap-1">
      {keys.map((key) => (
        <span
          key={key}
          className="h-4 w-4 rounded-chip border border-border"
          style={{ backgroundColor: tokens[key] ?? "transparent" }}
        />
      ))}
    </span>
  );
}
