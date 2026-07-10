"use client";

import { useEffect } from "react";
import { ArrowLeft, ArrowRight, Info } from "lucide-react";
import { useApp } from "../app/app-provider";
import type { ChainEntry, CredentialAvailability, EndpointPreset } from "../lib/types";
import { ChainBuilder, newEntry } from "../llm/chain-builder";
import { Icon } from "../ui/icon";
import { Button, Toggle } from "../ui/primitives";

export function StepLLM({
  chain,
  onChange,
  credentials,
  endpoints,
  onBack,
  onNext,
  canAdvance
}: {
  chain: ChainEntry[];
  onChange: (next: ChainEntry[]) => void;
  credentials: CredentialAvailability | null;
  endpoints: EndpointPreset[];
  onBack: () => void;
  onNext: () => void;
  canAdvance: boolean;
}) {
  const { config, updateConfig } = useApp();

  // Seed a first entry, defaulting to a provider with a detected env credential.
  useEffect(() => {
    if (chain.length === 0) {
      const detected = credentials
        ? (["gemini", "openrouter", "ollama", "openai-compatible"] as const).find((provider) => credentials.llm[provider])
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
          onChange={(value) => updateConfig({ tier2Enabled: value })}
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
