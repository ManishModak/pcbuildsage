"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Database, Download, Globe, Moon, Sliders, Sparkles, Sun, Wand2, X } from "lucide-react";
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
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icon";
import { Button, Card, ChoiceControl, ChoiceGroup, Toggle, Input, Field, IconButton } from "@/components/ui/primitives";
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

export const LOCAL_NAV_ITEMS: { id: SettingsTab; label: string; icon: typeof Sparkles }[] = [
  { id: "llm", label: "LLM Provider Chain", icon: Sparkles },
  { id: "search", label: "Web Search", icon: Globe },
  { id: "personalization", label: "Sage Personalization", icon: Sliders },
  { id: "database", label: "Scraping & Local Catalog", icon: Database }
];

export const HOSTED_NAV_ITEMS: { id: SettingsTab; label: string; icon: typeof Sparkles }[] = [
  { id: "market", label: "Market Preference", icon: Globe },
  { id: "llm", label: "LLM & BYOK Keys", icon: Sparkles },
  { id: "search", label: "Web Research", icon: Globe },
  { id: "personalization", label: "Sage Personalization", icon: Sliders }
];

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
  const [probeState, setProbeState] = useState<{ busy: boolean; message?: string; isError?: boolean }>({ busy: false });

  const handleTestSearch = async () => {
    setProbeState({ busy: true });
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
          message: `Connected successfully (${data.resultCount ?? 0} results returned).`,
          isError: false
        });
      } else {
        setProbeState({
          busy: false,
          message: data.error || "Search probe failed.",
          isError: true
        });
      }
    } catch (err) {
      setProbeState({
        busy: false,
        message: err instanceof Error ? err.message : "Network error during search probe.",
        isError: true
      });
    }
  };

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
        <header className="flex h-14 items-center justify-between gap-3 border-b border-border px-8 shrink-0 bg-surface">
          <div className="flex items-center gap-3">
            {/* Mobile-only opener: on phones the sidebar collapses to a Sheet
                whose own trigger is hidden, so surface one in the header. */}
            <SidebarTrigger className={cn("md:hidden", TRIGGER_HOVER)} />
            <div className="flex flex-col gap-0.5">
              <h1 className="text-md font-semibold text-text">Settings</h1>
              <p className="text-xs text-text-secondary">Providers, appearance, and build preferences.</p>
            </div>
          </div>
          {onClose ? (
            <IconButton icon={X} label="Close settings" onClick={onClose} />
          ) : null}
        </header>

        <div className="flex-1 overflow-y-auto px-8 py-6 max-w-4xl w-full mx-auto scrollbar-none">
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
                <Section title="LLM provider chain" description="Ordered failover chain. Reorder by dragging or with the up/down buttons.">
                  <CatalogNotice
                    status={endpointCatalog.status}
                    error={endpointCatalog.status === "error" ? endpointCatalog.message : undefined}
                    empty={endpointCatalog.status === "ready" && endpointCatalog.endpoints.length === 0}
                    loadingText="Loading local endpoint presets…"
                    errorTitle="Could not load local endpoint presets"
                    emptyText="No local endpoint presets are configured. Custom endpoints remain available."
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
              title={isHosted ? "Web research" : "Web search"}
              description={
                isHosted
                  ? "Configure optional live web research for technical component specifications."
                  : "Configure web search providers and crawling options."
              }
            >
              <Card className="flex flex-col gap-4 p-4">
                <Field label="Search provider">
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
                              { value: "none", label: "None (Research disabled)" },
                              { value: "tavily", label: "Tavily Search API" },
                              { value: "exa", label: "Exa AI Search" },
                              { value: "brave", label: "Brave Search API" }
                            ]
                          : [
                              { value: "none", label: "None (Disable search)" },
                              { value: "duckduckgo", label: "DuckDuckGo (HTML scraping)" },
                              { value: "searxng", label: "SearXNG (Self-hosted)" },
                              { value: "brave", label: "Brave Search API" },
                              { value: "tavily", label: "Tavily Search API" },
                              { value: "exa", label: "Exa AI Search" },
                              { value: "gemini-native", label: "Gemini Native Google Search" }
                            ]
                      }
                    />
                  )}
                </Field>

                {!isHosted && config.searchProvider === "searxng" && (
                  <Field label="SearXNG Base URL" hint="Example: http://localhost:8080">
                    {(controlProps) => (
                      <Input
                        {...controlProps}
                        type="text"
                        placeholder="http://localhost:8080"
                        value={config.searchBaseUrl || ""}
                        onChange={(e) => updateConfig({ searchBaseUrl: e.target.value || undefined })}
                      />
                    )}
                  </Field>
                )}

                {isHosted && ["brave", "tavily", "exa"].includes(config.searchProvider) && (
                  <div className="flex flex-col gap-3 rounded-card border border-border/60 bg-surface-raised p-3">
                    <Field
                      label={`${config.searchProvider.toUpperCase()} API Key`}
                      hint={
                        isByokKeyPersistent(config.searchProvider)
                          ? "Stored in browser localStorage."
                          : "Stored in browser sessionStorage (cleared when tab closes)."
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
                                  : `Enter ${config.searchProvider} API key`
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
                              Save Key
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
                                Clear
                              </Button>
                            )}
                          </div>
                          <label className="flex items-center gap-2 text-caption text-text-muted cursor-pointer">
                            <input
                              type="checkbox"
                              checked={hostedSearchRemember}
                              onChange={(e) => setHostedSearchRemember(e.target.checked)}
                              className="rounded border-border"
                            />
                            <span>Remember for this browser</span>
                          </label>
                        </div>
                      )}
                    </Field>
                  </div>
                )}

                {!isHosted && ["brave", "tavily", "exa"].includes(config.searchProvider) && (
                  <Field label="API key" hint="Saved locally in your browser.">
                    {(controlProps) => (
                      <Input
                        {...controlProps}
                        type="password"
                        placeholder="Enter API key"
                        value={uiKeys[config.searchProvider] || ""}
                        onChange={(e) => handleKeyChange(config.searchProvider, e.target.value)}
                      />
                    )}
                  </Field>
                )}

                {!isHosted && !["none", "gemini-native"].includes(config.searchProvider) && (
                  <Toggle
                    checked={config.crawlEnabled}
                    onChange={(value) => updateConfig({ crawlEnabled: value })}
                    label="Enable page crawling (Crawl4AI)"
                    description="Extracts main content from top search result for deeper context."
                  />
                )}

                {config.searchProvider !== "none" && (
                  <Field
                    label="Research model"
                    hint="Using 'Same as chat' shares model usage allowances with your chat conversation."
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
                          { value: "same-as-chat", label: "Same as chat (Shares model usage allowances)" },
                          ...(config.chatChain?.[0]?.model
                            ? [{ value: config.chatChain[0].model, label: `${config.chatChain[0].model} (Chat model)` }]
                            : [])
                        ]}
                      />
                    )}
                  </Field>
                )}

                {config.searchProvider !== "none" && (
                  <div className="pt-2 border-t border-border flex flex-col gap-2">
                    <div className="flex items-center gap-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={probeState.busy}
                        onClick={handleTestSearch}
                      >
                        {probeState.busy ? "Testing connection..." : "Test connection"}
                      </Button>
                      {probeState.message && (
                        <span
                          className={cn(
                            "text-caption font-medium",
                            probeState.isError ? "text-blocking" : "text-emerald-500"
                          )}
                        >
                          {probeState.message}
                        </span>
                      )}
                    </div>
                    <p className="text-caption text-text-muted">
                      Distinguishes network/authentication failure from empty search results without invoking an LLM.
                    </p>
                  </div>
                )}
              </Card>
            </Section>
          )}

          {activeTab === "personalization" && (
            <div className="flex flex-col gap-8">
              {!isHosted && <MarketPreferenceSection />}
              <Section title="Theme" description="Switching swaps the color set instantly — no reload.">
                <CatalogNotice
                  status={themeCatalog.status}
                  error={themeCatalog.status === "error" ? themeCatalog.message : undefined}
                  empty={themeCatalog.status === "ready" && themeCatalog.themes.length === 0}
                  loadingText="Loading themes…"
                  errorTitle="Could not load themes"
                  emptyText="No themes are installed. The built-in sage-dark colors remain active."
                />
                {themeCatalog.status === "ready" && themes.length > 0 ? (
                  <ChoiceGroup label="Theme" legendClassName="sr-only" className="grid gap-2 sm:grid-cols-2">
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
                          "flex items-center gap-3 rounded-card border bg-surface p-3 text-left transition-colors duration-150 cursor-pointer",
                          active ? "border-accent" : "border-border hover:border-text-muted"
                        )}
                      >
                        <Icon icon={theme.mode === "light" ? Sun : Moon} size={16} className="text-text-secondary" />
                        <span className="flex-1 text-sm text-text">{name}</span>
                        <ThemeSwatch tokens={theme.tokens} />
                        {active ? <Icon icon={Check} size={15} className="text-accent" /> : null}
                      </ChoiceControl>
                    );
                    })}
                  </ChoiceGroup>
                ) : null}
              </Section>

              <Section title="Personality" description="The tone the sage speaks in.">
                <CatalogNotice
                  status={personalityCatalog.status}
                  error={personalityCatalog.status === "error" ? personalityCatalog.message : undefined}
                  empty={personalityCatalog.status === "ready" && personalityCatalog.personalities.length === 0}
                  loadingText="Loading personalities…"
                  errorTitle="Could not load personalities"
                  emptyText="No personalities are installed."
                  onRetry={loadPersonalities}
                />
                {personalityCatalog.status === "ready" && personalities.length > 0 ? (
                  <ChoiceGroup label="Personality" legendClassName="sr-only" className="grid gap-2 sm:grid-cols-2">
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
                          "flex flex-col gap-0.5 rounded-card border bg-surface p-3 text-left transition-colors duration-150 cursor-pointer",
                          active ? "border-accent" : "border-border hover:border-text-muted"
                        )}
                      >
                        <span className="text-sm font-medium text-text">{personality.name}</span>
                        <span className="text-caption text-text-secondary">{personality.description}</span>
                      </ChoiceControl>
                    );
                    })}
                  </ChoiceGroup>
                ) : null}
              </Section>
            </div>
          )}

          {activeTab === "database" && !isHosted && (
            <div className="flex flex-col gap-8">
              <Section title="Research (Tier 2)" description="Advisory subagents — never override deterministic Tier 1 blocks.">
                <Card className="flex flex-col gap-4 p-4">
                  <Toggle
                    checked={config.tier2Enabled}
                    onChange={(value) => updateConfig({ tier2Enabled: value })}
                    label="Enable research subagents"
                    description="Research unknown specs and run advisory build audits."
                  />
                  <Toggle
                    checked={config.auditVisible}
                    onChange={(value) => updateConfig({ auditVisible: value })}
                    label="Show research in chat"
                    description="Surface consult tool chips and advisory audit notes inline."
                    disabled={!config.tier2Enabled}
                  />
                  <Toggle
                    checked={config.freeformConsultEnabled}
                    onChange={(value) => updateConfig({ freeformConsultEnabled: value })}
                    label="Freeform consultation"
                    description="Allow ad-hoc grounded questions beyond the build cascade."
                    disabled={!config.tier2Enabled}
                  />
                </Card>
              </Section>

              <Section title="Research registry" description="Export community-researched specs to contribute back.">
                <Card className="flex flex-col gap-3 p-4">
                  <div className="flex items-center justify-between gap-4">
                    <span className="flex items-center gap-2 text-sm text-text">
                      <Icon icon={Sparkles} size={16} className="text-unverified" />
                      Export researched specs
                    </span>
                    <Button variant="ghost" iconLeft={Download} loading={exportState.busy} onClick={runExport}>
                      Export
                    </Button>
                  </div>
                  {exportState.files ? (
                    <ul className="border-t border-border pt-3 font-mono text-caption text-text-secondary">
                      {exportState.files.length ? (
                        exportState.files.map((file) => <li key={file}>{file}</li>)
                      ) : (
                        <li>No researched specs to export yet.</li>
                      )}
                    </ul>
                  ) : null}
                  {exportState.error ? (
                    <p className="border-t border-border pt-3 text-caption" style={{ color: "var(--warn)" }}>
                      {exportState.error}
                    </p>
                  ) : null}
                </Card>
              </Section>

              <Section title="Scraping & Local Catalog Setup" description="Configure local product database and launch scraping jobs.">
                <Button
                  variant="ghost"
                  iconLeft={Wand2}
                  onClick={() => updateConfig({ onboarded: false })}
                >
                  Launch Scraping & Setup Wizard
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
      <Card className="flex items-start justify-between gap-3 p-3" role="alert">
        <div>
          <p className="text-caption font-medium text-text">{errorTitle}</p>
          {error ? <p className="text-caption text-text-secondary">{error}</p> : null}
        </div>
        {onRetry ? <Button variant="ghost" size="sm" onClick={onRetry}>Retry</Button> : null}
      </Card>
    );
  }
  return <p className="text-caption text-text-muted">{emptyText}</p>;
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-lg font-semibold text-text">{title}</h2>
        {description ? <p className="text-caption text-text-secondary">{description}</p> : null}
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
          className="h-4 w-4 rounded-full border border-border"
          style={{ backgroundColor: tokens[key] ?? "transparent" }}
        />
      ))}
    </span>
  );
}
