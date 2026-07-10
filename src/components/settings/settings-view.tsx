"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Download, Moon, Sparkles, Sun, Wand2 } from "lucide-react";
import { useApp } from "../app/app-provider";
import {
  exportResearch,
  fetchCredentials,
  fetchEndpoints,
  fetchPersonalities,
  fetchPersonas
} from "../lib/api";
import type { CredentialAvailability, EndpointPreset, Personality, Persona } from "../lib/types";
import { ChainBuilder } from "../llm/chain-builder";
import { cn } from "../ui/cn";
import { Icon } from "../ui/icon";
import { Button, Card, Toggle } from "../ui/primitives";

export function SettingsView() {
  const { config, themes, updateConfig, setTheme } = useApp();
  const [credentials, setCredentials] = useState<CredentialAvailability | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointPreset[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [personalities, setPersonalities] = useState<Personality[]>([]);
  const [exportState, setExportState] = useState<{ busy: boolean; files?: string[]; error?: string }>({ busy: false });

  useEffect(() => {
    fetchCredentials().then(setCredentials).catch(() => setCredentials(null));
    fetchEndpoints().then(setEndpoints).catch(() => setEndpoints([]));
    fetchPersonas().then(setPersonas).catch(() => setPersonas([]));
    fetchPersonalities().then(setPersonalities).catch(() => setPersonalities([]));
  }, []);

  const runExport = async () => {
    setExportState({ busy: true });
    try {
      const result = await exportResearch();
      setExportState({ busy: false, files: result.files });
    } catch (error) {
      setExportState({ busy: false, error: (error as Error).message });
    }
  };

  const togglePersona = (id: string) => {
    const active = config.personas.includes(id);
    const next = active ? config.personas.filter((item) => item !== id) : [...config.personas, id];
    updateConfig({ personas: next.length ? next : [id] });
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 py-8">
      <header className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-text">Settings</h1>
          <p className="text-sm text-text-secondary">Providers, appearance, and build preferences.</p>
        </div>
        <Link href="/">
          <Button variant="ghost" iconLeft={ArrowLeft}>
            Back to chat
          </Button>
        </Link>
      </header>

      <Section title="LLM provider chain" description="Ordered failover chain. Reorder by dragging or with the up/down buttons.">
        <ChainBuilder
          chain={config.chatChain}
          onChange={(next) => updateConfig({ chatChain: next })}
          credentials={credentials}
          endpoints={endpoints}
        />
      </Section>

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
                  "flex items-center gap-3 rounded-card border bg-surface p-3 text-left transition-colors duration-150",
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

      <Section title="Build personas" description="Which strategies the sage compares.">
        <div className="grid gap-2 sm:grid-cols-2">
          {personas.map((persona) => {
            const active = config.personas.includes(persona.id);
            return (
              <button
                key={persona.id}
                type="button"
                role="checkbox"
                aria-checked={active}
                onClick={() => togglePersona(persona.id)}
                className={cn(
                  "flex items-start gap-3 rounded-card border bg-surface p-3 text-left transition-colors duration-150",
                  active ? "border-accent" : "border-border hover:border-text-muted"
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border",
                    active ? "border-accent bg-accent text-on-accent" : "border-border"
                  )}
                >
                  {active ? <Icon icon={Check} size={13} /> : null}
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-text">{persona.persona_name}</span>
                  <span className="text-caption text-text-secondary">{persona.description}</span>
                </span>
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
                  "flex flex-col gap-0.5 rounded-card border bg-surface p-3 text-left transition-colors duration-150",
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

      <Section title="Onboarding" description="Re-run the setup wizard.">
        <Button
          variant="ghost"
          iconLeft={Wand2}
          onClick={() => updateConfig({ onboarded: false })}
        >
          Re-run onboarding wizard
        </Button>
      </Section>
    </div>
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
