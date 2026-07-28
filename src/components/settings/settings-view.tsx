"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Database, Download, Globe, Moon, Sliders, Sparkles, Sun, Wand2 } from "lucide-react";
import { useApp } from "../app/app-provider";
import {
  exportResearch,
  fetchCredentials,
  fetchEndpoints,
  fetchPersonalities
} from "../lib/api";
import type { ClientConfig, ThemeFile, CredentialAvailability, EndpointPreset, Personality, SearchProvider } from "../lib/types";
import { saveUiKey, type KeyMap } from "../lib/config-store";
import { ChainBuilder } from "../llm/chain-builder";
import { cn } from "../ui/cn";
import { Icon } from "../ui/icon";
import { Button, Card, Toggle, Input, Field } from "../ui/primitives";
import { Select } from "../ui/select";
import { LeafMark, Wordmark } from "../app/brand";
import { ThemeSwitcher } from "../app/theme-switcher";
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

type SettingsTab = "llm" | "search" | "personalization" | "database";

const NAV_ITEMS: { id: SettingsTab; label: string; icon: typeof Sparkles }[] = [
  { id: "llm", label: "LLM Provider Chain", icon: Sparkles },
  { id: "search", label: "Web Search", icon: Globe },
  { id: "personalization", label: "Sage Personalization", icon: Sliders },
  { id: "database", label: "Scraping & Local Catalog", icon: Database }
];

/**
 * Deep links like /settings?tab=database open straight to that panel. Read as
 * lazy initial state rather than in an effect: SettingsView only mounts once
 * the app provider reports `ready`, which is always post-hydration, so there is
 * no server render for this to disagree with.
 */
function initialTab(): SettingsTab {
  if (typeof window === "undefined") return "llm";
  const requested = new URLSearchParams(window.location.search).get("tab");
  return NAV_ITEMS.some((item) => item.id === requested) ? (requested as SettingsTab) : "llm";
}

interface SettingsLayoutProps {
  config: ClientConfig;
  themes: ThemeFile[];
  updateConfig: (patch: Partial<ClientConfig>) => void;
  setTheme: (name: string) => void;
  credentials: CredentialAvailability | null;
  endpoints: EndpointPreset[];
  personalities: Personality[];
  exportState: { busy: boolean; files?: string[]; error?: string };
  uiKeys: KeyMap;
  activeTab: SettingsTab;
  setActiveTab: (tab: SettingsTab) => void;
  handleKeyChange: (provider: string, value: string) => void;
  runExport: () => Promise<void>;
}

function SettingsLayout({
  config,
  themes,
  updateConfig,
  setTheme,
  credentials,
  endpoints,
  personalities,
  exportState,
  uiKeys,
  activeTab,
  setActiveTab,
  handleKeyChange,
  runExport
}: SettingsLayoutProps) {
  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader className="h-14 flex-row items-center justify-between border-b border-border px-2">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-btn px-1"
            aria-label="PCBuildSage home"
          >
            <LeafMark size={22} />
            <Wordmark className="text-base group-data-[collapsible=icon]:hidden" />
          </Link>
          <SidebarTrigger className={cn("group-data-[collapsible=icon]:hidden", TRIGGER_HOVER)} />
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Settings</SidebarGroupLabel>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    isActive={activeTab === item.id}
                    onClick={() => setActiveTab(item.id)}
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
              <SidebarMenuButton asChild tooltip="Back to chat">
                <Link href="/">
                  <Icon icon={ArrowLeft} size={16} />
                  <span>Back to chat</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <ThemeSwitcher variant="sidebar" />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      {/* Main Settings Content */}
      <div className="flex h-dvh min-w-0 flex-1 flex-col bg-bg">
        <header className="flex h-14 items-center gap-3 border-b border-border px-8 shrink-0 bg-surface">
          {/* Mobile-only opener: on phones the sidebar collapses to a Sheet
              whose own trigger is hidden, so surface one in the header. */}
          <SidebarTrigger className={cn("md:hidden", TRIGGER_HOVER)} />
          <div className="flex flex-col gap-0.5">
            <h1 className="text-md font-semibold text-text">Settings</h1>
            <p className="text-xs text-text-secondary">Providers, appearance, and build preferences.</p>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-8 py-6 max-w-4xl w-full mx-auto scrollbar-none">
          {activeTab === "llm" && (
            <Section title="LLM provider chain" description="Ordered failover chain. Reorder by dragging or with the up/down buttons.">
              <ChainBuilder
                chain={config.chatChain}
                onChange={(next) => updateConfig({ chatChain: next })}
                credentials={credentials}
                endpoints={endpoints}
              />
            </Section>
          )}

          {activeTab === "search" && (
            <Section title="Web search" description="Configure web search providers and crawling options.">
              <Card className="flex flex-col gap-4 p-4">
                <Field label="Search provider">
                  <Select
                    value={config.searchProvider}
                    onChange={(e) => updateConfig({ searchProvider: e.target.value as SearchProvider })}
                    options={[
                      { value: "none", label: "None (Disable search)" },
                      { value: "duckduckgo", label: "DuckDuckGo (HTML scraping)" },
                      { value: "searxng", label: "SearXNG (Self-hosted)" },
                      { value: "brave", label: "Brave Search API" },
                      { value: "tavily", label: "Tavily Search API" },
                      { value: "exa", label: "Exa AI Search" },
                      { value: "gemini-native", label: "Gemini Native Google Search" }
                    ]}
                  />
                </Field>

                {config.searchProvider === "searxng" && (
                  <Field label="SearXNG Base URL" hint="Example: http://localhost:8080">
                    <Input
                      type="text"
                      placeholder="http://localhost:8080"
                      value={config.searchBaseUrl || ""}
                      onChange={(e) => updateConfig({ searchBaseUrl: e.target.value || undefined })}
                    />
                  </Field>
                )}

                {["brave", "tavily", "exa"].includes(config.searchProvider) && (
                  <Field label="API key" hint="Saved locally in your browser.">
                    <Input
                      type="password"
                      placeholder="Enter API key"
                      value={uiKeys[config.searchProvider] || ""}
                      onChange={(e) => handleKeyChange(config.searchProvider, e.target.value)}
                    />
                  </Field>
                )}

                {!["none", "gemini-native"].includes(config.searchProvider) && (
                  <Toggle
                    checked={config.crawlEnabled}
                    onChange={(value) => updateConfig({ crawlEnabled: value })}
                    label="Enable page crawling (Crawl4AI)"
                    description="Extracts main content from top search result for deeper context."
                  />
                )}
              </Card>
            </Section>
          )}

          {activeTab === "personalization" && (
            <div className="flex flex-col gap-8">
              <Section title="Theme" description="Switching swaps the color set instantly — no reload.">
                <div className="grid gap-2 sm:grid-cols-2">
                  {themes.map((theme) => {
                    const name = theme.theme_name ?? theme.id;
                    const active = name === config.theme;
                    return (
                      <button
                        key={theme.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setTheme(name)}
                        className={cn(
                          "flex items-center gap-3 rounded-card border bg-surface p-3 text-left transition-colors duration-150 cursor-pointer",
                          active ? "border-accent" : "border-border hover:border-text-muted"
                        )}
                      >
                        <Icon icon={theme.mode === "light" ? Sun : Moon} size={16} className="text-text-secondary" />
                        <span className="flex-1 text-sm text-text">{name}</span>
                        <ThemeSwatch tokens={theme.tokens} />
                        {active ? <Icon icon={Check} size={15} className="text-accent" /> : null}
                      </button>
                    );
                  })}
                </div>
              </Section>

              <Section title="Personality" description="The tone the sage speaks in.">
                <div className="grid gap-2 sm:grid-cols-2">
                  {personalities.map((personality) => {
                    const active = config.personality === personality.id;
                    return (
                      <button
                        key={personality.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => updateConfig({ personality: personality.id })}
                        className={cn(
                          "flex flex-col gap-0.5 rounded-card border bg-surface p-3 text-left transition-colors duration-150 cursor-pointer",
                          active ? "border-accent" : "border-border hover:border-text-muted"
                        )}
                      >
                        <span className="text-sm font-medium text-text">{personality.name}</span>
                        <span className="text-caption text-text-secondary">{personality.description}</span>
                      </button>
                    );
                  })}
                </div>
              </Section>
            </div>
          )}

          {activeTab === "database" && (
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

export function SettingsView() {
  const { config, themes, updateConfig, setTheme } = useApp();
  const [credentials, setCredentials] = useState<CredentialAvailability | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointPreset[]>([]);
  const [personalities, setPersonalities] = useState<Personality[]>([]);
  const [exportState, setExportState] = useState<{ busy: boolean; files?: string[]; error?: string }>({ busy: false });
  // Keys the user types this session. Deliberately not seeded from storage:
  // saved keys are write-only (see KeyMap in config-store) and reach the server
  // as headers via apiKeyHeaders, so they never need to be read back into an input.
  const [uiKeys, setUiKeys] = useState<KeyMap>({});
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);

  useEffect(() => {
    fetchCredentials().then(setCredentials).catch(() => setCredentials(null));
    fetchEndpoints().then(setEndpoints).catch(() => setEndpoints([]));
    fetchPersonalities().then(setPersonalities).catch(() => setPersonalities([]));
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
      setExportState({ busy: false, error: (error as Error).message });
    }
  };

  return (
    <SidebarProvider defaultOpen className="h-dvh overflow-hidden bg-bg text-text">
      <SettingsLayout
        config={config}
        themes={themes}
        updateConfig={updateConfig}
        setTheme={setTheme}
        credentials={credentials}
        endpoints={endpoints}
        personalities={personalities}
        exportState={exportState}
        uiKeys={uiKeys}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        handleKeyChange={handleKeyChange}
        runExport={runExport}
      />
    </SidebarProvider>
  );
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
