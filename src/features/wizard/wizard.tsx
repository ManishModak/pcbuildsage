"use client";

import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { useApp } from "@/components/app/app-provider";
import { fetchCredentials, fetchEndpoints, fetchStatus } from "@/lib/api-client";
import type { ChainEntry, CredentialAvailability, EndpointPreset, StatusResponse } from "@/types/client";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icon";
import { StepChat } from "./step-chat";
import { StepDataSource, type DataSourceChoice } from "./step-data-source";
import { StepLLM } from "./step-llm";
import { StepScrape } from "./step-scrape";

const STEPS = ["Data source", "Fetch data", "AI providers", "Personalize"];

export function Wizard({ onComplete }: { onComplete: () => void }) {
  const { config, updateConfig } = useApp();
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<"forward" | "back">("forward");

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [credentials, setCredentials] = useState<CredentialAvailability | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointPreset[]>([]);
  const [dataSource, setDataSource] = useState<DataSourceChoice | null>(null);
  const [chain, setChain] = useState<ChainEntry[]>(config.chatChain);

  useEffect(() => {
    fetchStatus().then(setStatus).catch(() => setStatus(null));
    fetchCredentials().then(setCredentials).catch(() => setCredentials(null));
    fetchEndpoints().then(setEndpoints).catch(() => setEndpoints([]));
  }, []);

  const go = (next: number) => {
    setDirection(next > step ? "forward" : "back");
    setStep(next);
  };

  const primary = chain[0];
  const primaryReady = Boolean(primary?.model) && Boolean(primary?.ping?.toolCapable);

  const canAdvance = useMemo(() => {
    if (step === 0) return dataSource !== null;
    if (step === 2) return primaryReady;
    return true;
  }, [step, dataSource, primaryReady]);

  const finish = () => {
    updateConfig({ onboarded: true, chatChain: chain });
    onComplete();
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:py-12 md:flex-row md:gap-10">
      <Stepper step={step} onJump={(index) => index < step && go(index)} />

      <div className="min-w-0 flex-1">
        <div key={step} className={direction === "forward" ? "pcbs-slide-forward" : "pcbs-slide-back"}>
          {step === 0 ? (
            <StepDataSource
              status={status}
              choice={dataSource}
              onChoose={setDataSource}
              onNext={() => go(1)}
            />
          ) : null}
          {step === 1 ? (
            <StepScrape
              dataSource={dataSource}
              status={status}
              onBack={() => go(0)}
              onNext={() => go(2)}
            />
          ) : null}
          {step === 2 ? (
            <StepLLM
              chain={chain}
              onChange={setChain}
              credentials={credentials}
              endpoints={endpoints}
              onBack={() => go(1)}
              onNext={() => go(3)}
              canAdvance={primaryReady}
            />
          ) : null}
          {step === 3 ? <StepChat onBack={() => go(2)} onFinish={finish} /> : null}
        </div>

        {step !== 0 && step !== 3 ? (
          <NavHint canAdvance={canAdvance} step={step} primaryReady={primaryReady} />
        ) : null}
      </div>
    </div>
  );
}

function Stepper({ step, onJump }: { step: number; onJump: (index: number) => void }) {
  return (
    <nav aria-label="Onboarding progress" className="md:w-44 md:shrink-0">
      {/* Mobile: progress dots */}
      <ol className="flex items-center gap-2 md:hidden">
        {STEPS.map((label, index) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                "h-2 w-2 rounded-pill",
                index === step ? "bg-accent" : index < step ? "bg-accent/60" : "bg-border"
              )}
              style={index < step ? { backgroundColor: "color-mix(in srgb, var(--accent) 60%, transparent)" } : undefined}
            />
          </li>
        ))}
        <li className="ml-1 text-caption text-text-secondary">{STEPS[step]}</li>
      </ol>

      {/* Desktop: left-aligned vertical stepper */}
      <ol className="hidden flex-col gap-1 md:flex">
        {STEPS.map((label, index) => {
          const done = index < step;
          const current = index === step;
          return (
            <li key={label}>
              <button
                type="button"
                disabled={!done}
                onClick={() => onJump(index)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-btn px-2 py-2 text-left text-sm transition-colors duration-150",
                  done ? "text-text hover:bg-surface-raised" : current ? "text-text" : "text-text-muted"
                )}
              >
                <span
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-pill border font-mono text-caption",
                    current ? "border-accent text-accent" : done ? "border-accent bg-accent text-on-accent" : "border-border"
                  )}
                >
                  {done ? <Icon icon={Check} size={13} /> : index + 1}
                </span>
                {label}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function NavHint({ canAdvance, step, primaryReady }: { canAdvance: boolean; step: number; primaryReady: boolean }) {
  if (canAdvance) return null;
  if (step === 2 && !primaryReady) {
    return (
      <p className="mt-4 text-caption text-text-muted">
        Ping your primary provider and confirm tool support before continuing.
      </p>
    );
  }
  return null;
}
