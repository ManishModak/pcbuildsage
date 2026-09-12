"use client";

import { useEffect } from "react";
import { ArrowLeft, ArrowRight, Info } from "lucide-react";
import { useApp } from "@/components/app/app-provider";
import type { ChainEntry, CredentialAvailability, EndpointPreset } from "@/types/client";
import { ChainBuilder, newEntry } from "@/features/llm/chain-builder";
import { Icon } from "@/components/ui/icon";
import { Button, Card, Toggle } from "@/components/ui/primitives";

export type EndpointLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; endpoints: EndpointPreset[] };

export function StepLLM({
  chain,
  onChange,
  credentials,
  endpointState,
  onRetryEndpoints,
  onBack,
  onNext,
  canAdvance
}: {
  chain: ChainEntry[];
  onChange: (next: ChainEntry[]) => void;
  credentials: CredentialAvailability | null;
  endpointState: EndpointLoadState;
  onRetryEndpoints: () => void;
  onBack: () => void;
  onNext: () => void;
  canAdvance: boolean;
}) {
  const { config, updateConfig } = useApp();
  const endpoints = endpointState.status === "ready" ? endpointState.endpoints : [];

  // Seed a first entry, defaulting to a provider with a detected env credential.
  useEffect(() => {
    if (chain.length === 0) {
      const detected = credentials
        ? (["gemini", "groq", "openrouter", "ollama", "openai-compatible"] as const).find((provider) => credentials.llm[provider])
        : undefined;
      onChange([newEntry(detected ? { provider: detected } : {})]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentials]);

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-text">Connect your AI providers</h1>
        <p className="text-base text-text-secondary">
          Build an ordered fallback chain. The first tool-capable provider serves chat; the rest catch transient
          failures. Keys entered here are stored locally and sent only as request headers — never rendered back.
        </p>
      </header>

      {endpointState.status === "loading" ? (
        <p className="text-caption text-text-muted" aria-live="polite">Loading local endpoint presets…</p>
      ) : endpointState.status === "error" ? (
        <Card className="flex items-start justify-between gap-3 p-3" role="alert">
          <div>
            <p className="text-caption font-medium text-text">Could not load local endpoint presets</p>
            <p className="text-caption text-text-secondary">{endpointState.message}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onRetryEndpoints}>Retry</Button>
        </Card>
      ) : endpointState.endpoints.length === 0 ? (
        <p className="text-caption text-text-muted">No local endpoint presets are configured. Custom endpoints remain available.</p>
      ) : null}

      <ChainBuilder chain={chain} onChange={onChange} credentials={credentials} endpoints={endpoints} />

      <div className="flex items-start gap-2 rounded-card border border-border bg-surface px-4 py-3 text-caption text-text-secondary">
        <Icon icon={Info} size={15} className="mt-0.5 text-text-muted" />
        This app is tool-driven, so the chat primary must support tool calling. Local servers usually need a launch
        flag (e.g. vLLM <code className="font-mono">--enable-auto-tool-choice --tool-call-parser …</code>) — the probe
        reports the exact one.
      </div>

      <div className="flex flex-col gap-4 rounded-card border border-border bg-surface px-4 py-4">
        <Toggle
          checked={config.tier2Enabled}
          onChange={(value: boolean) => updateConfig({ tier2Enabled: value })}
          label="Tier 2 research subagents"
          description="Let the sage research unknown specs and run advisory build audits. Advisory only — never overrides Tier 1 blocks."
        />
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="ghost" iconLeft={ArrowLeft} onClick={onBack}>
          Back
        </Button>
        <Button iconRight={ArrowRight} onClick={onNext} disabled={!canAdvance}>
          Continue
        </Button>
      </div>
    </section>
  );
}
