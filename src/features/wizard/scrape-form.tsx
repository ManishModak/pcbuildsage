"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  FlaskConical,
  Play,
  Upload,
  X
} from "lucide-react";
import { fetchProfiles, postSse, testProfile } from "@/lib/api-client";
import { loadLastScrape, saveLastScrape } from "@/lib/client-config-store";
import { estimateScrapeMinutes } from "@/lib/format";
import type { ProfileSummary, ScrapeRunConfig } from "@/types/client";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icon";
import { Button, Card, Field, Input, Toggle } from "@/components/ui/primitives";
import { Select } from "@/components/ui/select";
import { ProfileImportDialog } from "./profile-import";
import { ScrapeProgress } from "./scrape-progress";
import {
  createInitialScrapeStreamState,
  scrapeStreamReducer,
  toScrapeStreamAction
} from "./scrape-stream-reducer";

type Depth = "quick" | "full" | "custom";
type Phase = "config" | "running" | "done";

export function ScrapeForm({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [profileId, setProfileId] = useState("");
  const [sites, setSites] = useState<Set<string>>(new Set());
  const [categories, setCategories] = useState<Set<string>>(new Set());
  const [depth, setDepth] = useState<Depth>("quick");
  const [maxPages, setMaxPages] = useState(5);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advanced, setAdvanced] = useState({
    skipFreshOn: false,
    skipFreshHours: 24,
    noLlmFallback: false,
    maxLlmCalls: 25,
    concurrency: 2,
    delayMs: 1000,
    headed: false,
    dbPath: ""
  });

  const [importOpen, setImportOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("config");
  const [stream, dispatch] = useReducer(scrapeStreamReducer, undefined, createInitialScrapeStreamState);
  const [testing, setTesting] = useState(false);
  const [testOutput, setTestOutput] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Cancel any in-flight scrape stream when the step unmounts (navigation away).
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    []
  );

  const loadProfiles = (preferred?: string) =>
    fetchProfiles().then((list) => {
      setProfiles(list);
      const chosen = preferred && list.some((p) => p.id === preferred) ? preferred : list[0]?.id ?? "";
      if (chosen && chosen !== profileId) selectProfile(chosen, list);
    });

  useEffect(() => {
    const last = loadLastScrape();
    fetchProfiles().then((list) => {
      setProfiles(list);
      const chosen = last?.profile && list.some((p) => p.id === last.profile) ? last.profile : list[0]?.id ?? "";
      if (chosen) {
        selectProfile(chosen, list, last ?? undefined);
        if (last?.quick === false && last.maxPages) {
          setDepth("custom");
          setMaxPages(last.maxPages);
        }
      }
    });
  }, []);

  const activeProfile = profiles.find((profile) => profile.id === profileId);

  function selectProfile(id: string, list: ProfileSummary[], last?: Partial<ScrapeRunConfig>) {
    const profile = list.find((item) => item.id === id);
    setProfileId(id);
    const allSites = new Set(profile?.sites.map((site) => site.name ?? "").filter(Boolean));
    const allCategories = new Set(profile?.sites.flatMap((site) => site.categories) ?? []);
    setSites(last?.sites?.length ? new Set(last.sites) : allSites);
    setCategories(last?.categories?.length ? new Set(last.categories) : allCategories);
  }

  const availableSites = useMemo(
    () => activeProfile?.sites.map((site) => site.name ?? "").filter(Boolean) ?? [],
    [activeProfile]
  );
  const availableCategories = useMemo(
    () => Array.from(new Set(activeProfile?.sites.flatMap((site) => site.categories) ?? [])),
    [activeProfile]
  );

  const estimate = useMemo(() => {
    const jobs = availableSites
      .filter((site) => sites.has(site))
      .reduce((count, site) => {
        const profileSite = activeProfile?.sites.find((item) => item.name === site);
        const cats = profileSite?.categories.filter((cat) => categories.has(cat)) ?? [];
        return count + cats.length;
      }, 0);
    const depthPages = depth === "quick" ? 2 : depth === "custom" ? maxPages : 3;
    return estimateScrapeMinutes(jobs, jobs * depthPages, advanced.delayMs);
  }, [availableSites, sites, categories, depth, maxPages, advanced.delayMs, activeProfile]);

  const buildRunConfig = (): ScrapeRunConfig => ({
    profile: profileId,
    sites: sites.size === availableSites.length ? undefined : Array.from(sites),
    categories: categories.size === availableCategories.length ? undefined : Array.from(categories),
    quick: depth === "quick",
    maxPages: depth === "custom" ? maxPages : undefined,
    skipFresh: advanced.skipFreshOn ? advanced.skipFreshHours : undefined,
    noLlmFallback: advanced.noLlmFallback || undefined,
    maxLlmCalls: advanced.noLlmFallback ? undefined : advanced.maxLlmCalls,
    concurrency: advanced.concurrency,
    delayMs: advanced.delayMs,
    headed: advanced.headed || undefined,
    db: advanced.dbPath.trim() || undefined
  });

  const startScrape = async () => {
    const config = buildRunConfig();
    saveLastScrape(config);
    setPhase("running");
    dispatch({ type: "reset" });
    const controller = new AbortController();
    abortRef.current = controller;

    await postSse("/api/scrape", config, (event, data) => {
      if (controller.signal.aborted) return;
      const action = toScrapeStreamAction(event, data);
      if (action) dispatch(action);
    }, controller.signal).catch((error) => {
      if (!controller.signal.aborted) dispatch({ type: "stream_failed", message: (error as Error).message });
    });
    if (controller.signal.aborted) return;
    setPhase("done");
    abortRef.current = null;
  };

  const stopScrape = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setPhase("config");
  };

  const runTest = async () => {
    setTesting(true);
    setTestOutput(null);
    try {
      const firstSite = Array.from(sites)[0];
      const result = await testProfile({
        profile: profileId,
        site: firstSite,
        categories: Array.from(categories)
      });
      setTestOutput((result.stdout || result.stderr || "No output.").trim());
    } catch (error) {
      setTestOutput((error as Error).message);
    } finally {
      setTesting(false);
    }
  };

  if (phase !== "config") {
    return (
      <section className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-text">Scraping {activeProfile?.profileName ?? profileId}</h1>
          <p className="text-base text-text-secondary">
            Live progress below. Data is written as it arrives — you can continue once it settles.
          </p>
        </header>
        {stream.runError ? <RunError message={stream.runError} /> : null}
        <ScrapeProgress
          rows={Array.from(stream.rows.values())}
          logs={stream.logs}
          running={phase === "running"}
          productsWritten={stream.productsWritten}
        />
        <div className="flex items-center justify-between">
          {phase === "running" ? (
            <Button variant="danger" iconLeft={X} onClick={stopScrape}>
              Stop scrape
            </Button>
          ) : (
            <Button variant="ghost" iconLeft={ArrowLeft} onClick={() => setPhase("config")}>
              Back to options
            </Button>
          )}
          <Button iconRight={ArrowRight} onClick={onNext} disabled={phase === "running"}>
            Continue
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-text">Configure the scrape</h1>
        <p className="text-base text-text-secondary">
          Community profiles define how each site is crawled. Choose what to fetch right now.
        </p>
      </header>

      <div className="flex flex-col gap-5">
        <Field label="Profile">
          <div className="flex gap-2">
            <Select
              className="flex-1"
              value={profileId}
              options={profiles.map((profile) => ({
                value: profile.id,
                label: `${profile.flag ? `${profile.flag} ` : ""}${profile.profileName ?? profile.id} · ${profile.siteCount} sites`
              }))}
              onChange={(event) => selectProfile(event.target.value, profiles)}
            />
            <Button variant="ghost" iconLeft={Upload} onClick={() => setImportOpen(true)}>
              Import
            </Button>
          </div>
        </Field>

        <CheckboxGroup
          label="Sites"
          options={availableSites}
          selected={sites}
          onToggle={(value) => setSites((prev) => toggle(prev, value))}
        />

        <CheckboxGroup
          label="Categories"
          options={availableCategories}
          selected={categories}
          onToggle={(value) => setCategories((prev) => toggle(prev, value))}
        />

        <Field label="Depth">
          <div className="flex flex-wrap gap-2">
            <DepthOption value="quick" active={depth === "quick"} onSelect={setDepth} label="Quick" sub="2 pages/category" />
            <DepthOption value="full" active={depth === "full"} onSelect={setDepth} label="Full" sub="profile max_pages" />
            <DepthOption value="custom" active={depth === "custom"} onSelect={setDepth} label="Custom" sub="set max pages" />
            {depth === "custom" ? (
              <Input
                type="number"
                min={1}
                mono
                value={maxPages}
                onChange={(event) => setMaxPages(Math.max(1, Number(event.target.value) || 1))}
                className="w-24"
                aria-label="Max pages"
              />
            ) : null}
          </div>
        </Field>

        {/* Advanced — collapsed by default (layout discipline). */}
        <div className="rounded-card border border-border">
          <button
            type="button"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((prev) => !prev)}
            className="flex w-full items-center gap-2 px-4 py-3 text-sm text-text-secondary hover:text-text"
          >
            <Icon icon={advancedOpen ? ChevronDown : ChevronRight} size={16} />
            Advanced options
          </button>
          {advancedOpen ? (
            <div className="flex flex-col gap-4 border-t border-border px-4 py-4">
              <Toggle
                checked={advanced.skipFreshOn}
                onChange={(value) => setAdvanced((prev) => ({ ...prev, skipFreshOn: value }))}
                label="Skip freshly-scraped"
                description={`Skip a site+category scraped within ${advanced.skipFreshHours} hours.`}
              />
              <Toggle
                checked={!advanced.noLlmFallback}
                onChange={(value) => setAdvanced((prev) => ({ ...prev, noLlmFallback: !value }))}
                label="LLM extraction fallback"
                description="Use an LLM when CSS selectors miss fields. Auto-disable if no scraper credential resolves."
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Per-site LLM call budget">
                  <Input
                    type="number"
                    min={0}
                    mono
                    disabled={advanced.noLlmFallback}
                    value={advanced.maxLlmCalls}
                    onChange={(event) => setAdvanced((prev) => ({ ...prev, maxLlmCalls: Number(event.target.value) || 0 }))}
                  />
                </Field>
                <Field label="Concurrent sites">
                  <Input
                    type="number"
                    min={1}
                    mono
                    value={advanced.concurrency}
                    onChange={(event) => setAdvanced((prev) => ({ ...prev, concurrency: Math.max(1, Number(event.target.value) || 1) }))}
                  />
                </Field>
                <Field label="Delay between requests (ms)">
                  <Input
                    type="number"
                    min={0}
                    mono
                    value={advanced.delayMs}
                    onChange={(event) => setAdvanced((prev) => ({ ...prev, delayMs: Number(event.target.value) || 0 }))}
                  />
                </Field>
                <Field label="Database path" hint="Defaults to data/products.db">
                  <Input
                    mono
                    value={advanced.dbPath}
                    placeholder="data/products.db"
                    onChange={(event) => setAdvanced((prev) => ({ ...prev, dbPath: event.target.value }))}
                  />
                </Field>
              </div>
              <Toggle
                checked={advanced.headed}
                onChange={(value) => setAdvanced((prev) => ({ ...prev, headed: value }))}
                label="Headed debug browser"
                description="Show the browser window while crawling (slower)."
              />
            </div>
          ) : null}
        </div>

        {testOutput !== null ? (
          <Card className="p-3">
            <p className="mb-2 text-caption font-medium text-text-secondary">Test profile output</p>
            <pre className="max-h-48 overflow-auto font-mono text-caption text-text-secondary">{testOutput}</pre>
          </Card>
        ) : null}
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3 border-t border-border pt-4">
        <Button variant="ghost" iconLeft={ArrowLeft} onClick={onBack}>
          Back
        </Button>
        <div className="flex items-start gap-3">
          <Button variant="ghost" iconLeft={FlaskConical} loading={testing} onClick={runTest} disabled={!profileId}>
            Test profile
          </Button>
          <div className="flex flex-col items-end">
            <Button iconLeft={Play} onClick={startScrape} disabled={!profileId || sites.size === 0 || categories.size === 0}>
              Start scrape
            </Button>
            <span className="mt-1 font-mono text-caption text-text-muted">estimated {estimate.label}</span>
          </div>
        </div>
      </div>

      <ProfileImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(id) => void loadProfiles(id)}
      />
    </section>
  );
}

function RunError({ message }: { message: string }) {
  return (
    <div
      className="rounded-card border px-4 py-3 text-caption"
      style={{ color: "var(--warn)", borderColor: "color-mix(in srgb, var(--warn) 45%, transparent)" }}
    >
      {message}
    </div>
  );
}

function DepthOption({
  value,
  active,
  onSelect,
  label,
  sub
}: {
  value: Depth;
  active: boolean;
  onSelect: (value: Depth) => void;
  label: string;
  sub: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={() => onSelect(value)}
      className={cn(
        "flex min-h-11 flex-col items-start rounded-btn border px-3 py-1.5 text-left transition-colors duration-150",
        active ? "border-accent" : "border-border hover:border-text-muted"
      )}
    >
      <span className="text-sm text-text">{label}</span>
      <span className="font-mono text-caption text-text-muted">{sub}</span>
    </button>
  );
}

function CheckboxGroup({
  label,
  options,
  selected,
  onToggle
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onToggle: (value: string) => void;
}) {
  if (options.length === 0) {
    return (
      <Field label={label}>
        <p className="text-caption text-text-muted">None available in this profile.</p>
      </Field>
    );
  }
  return (
    <Field label={label}>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const checked = selected.has(option);
          return (
            <button
              key={option}
              type="button"
              role="checkbox"
              aria-checked={checked}
              onClick={() => onToggle(option)}
              className={cn(
                "min-h-9 rounded-chip border px-3 text-caption transition-colors duration-150",
                checked ? "border-accent text-text" : "border-border text-text-secondary hover:border-text-muted"
              )}
            >
              {option}
            </button>
          );
        })}
      </div>
    </Field>
  );
}

function toggle(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
