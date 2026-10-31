"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { useApp } from "@/components/app/app-provider";
import { fetchCredentials, fetchEndpoints, fetchMarkets, fetchStatus, isHostedMode } from "@/lib/api-client";
import { getErrorMessage } from "@/lib/format";
import type { ChainEntry, CredentialAvailability, MarketMetadata } from "@/types/client";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icon";
import { Button, Card, Spinner } from "@/components/ui/primitives";
import { MarketPreferenceSection } from "@/features/settings/market-preference-section";
import { setMarketPreference } from "@/lib/market/client-market-store";
import { StepDataSource, type DataSourceChoice, type StatusLoadState } from "./step-data-source";
import { StepHostedModel } from "./step-hosted-model";
import { StepLLM, type EndpointLoadState } from "./step-llm";
import { StepScrape } from "./step-scrape";
import { StepHeader } from "./simple-panel";
import { shouldSkipMarketStep } from "./hosted-gating";

// Setup ends on the AI model step: the sage's tone is a Settings choice, not
// something to ask before the first build.
const LOCAL_STEPS = ["Data source", "Fetch data", "AI model"];
// An existing database needs no fetch, so its setup goes straight to the model.
const LOCAL_STEPS_EXISTING = ["Data source", "AI model"];
const HOSTED_STEPS = ["Region and currency", "AI model"];

export function Wizard({ onComplete, onExit }: { onComplete: () => void; onExit?: () => void }) {
  const { config, updateConfig } = useApp();
  const [step, setStep] = useState(0);

  const [statusState, setStatusState] = useState<StatusLoadState>({ status: "loading" });
  const [credentials, setCredentials] = useState<CredentialAvailability | null>(null);
  const [endpointState, setEndpointState] = useState<EndpointLoadState>({ status: "loading" });
  const [dataSource, setDataSource] = useState<DataSourceChoice | null>(null);
  const [chain, setChain] = useState<ChainEntry[]>(config.chatChain);
  const [markets, setMarkets] = useState<MarketMetadata[] | null>(null);

  const requestStatus = useCallback(
    () => fetchStatus()
      .then((data) => setStatusState({ status: "ready", data }))
      .catch((error) => setStatusState({ status: "error", message: getErrorMessage(error) })),
    []
  );

  const loadStatus = useCallback(() => {
    setStatusState({ status: "loading" });
    void requestStatus();
  }, [requestStatus]);

  const requestEndpoints = useCallback(
    () => fetchEndpoints()
      .then((endpoints) => setEndpointState({ status: "ready", endpoints }))
      .catch((error) => setEndpointState({ status: "error", message: getErrorMessage(error) })),
    []
  );

  const loadEndpoints = useCallback(() => {
    setEndpointState({ status: "loading" });
    void requestEndpoints();
  }, [requestEndpoints]);

  useEffect(() => {
    void requestStatus();
    fetchCredentials().then(setCredentials).catch(() => setCredentials(null));
    void requestEndpoints();
    fetchMarkets().then(setMarkets).catch(() => setMarkets([]));
  }, [requestStatus, requestEndpoints]);

  const isHosted =
    (statusState.status === "ready" &&
      (statusState.data.deploymentMode === "hosted-demo" || statusState.data.mode === "hosted-demo")) ||
    isHostedMode();

  const steps = isHosted ? HOSTED_STEPS : dataSource === "existing" ? LOCAL_STEPS_EXISTING : LOCAL_STEPS;

  const go = (next: number) => {
    setStep(next);
  };

  // Skip the market step when a single market leaves nothing to choose.
  // Once only: going Back to it afterwards must not bounce forward again.
  const marketSkipDone = useRef(false);
  useEffect(() => {
    if (marketSkipDone.current || !isHosted || step !== 0 || !markets || !shouldSkipMarketStep(markets)) return;
    marketSkipDone.current = true;
    const only = markets[0];
    const updated = setMarketPreference({
      countryCode: only.code,
      currencyCode: only.defaultCurrency,
      locale: only.locale
    });
    updateConfig({ countryCode: updated.countryCode, currency: updated.currencyCode });
    setStep(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-way auto-skip on first eligible paint
  }, [isHosted, step, markets]);

  const primary = chain[0];
  const primaryReady = Boolean(primary?.model) && Boolean(primary?.ping?.toolCapable);

  // Hosted: StepHostedModel calls this only after its model check passed, and
  // ByokSection already keeps config.chatChain current. Local: the chain built
  // on the AI model step, which only continues once the main model passed.
  const finish = () => {
    updateConfig({ onboarded: true, ...(!isHosted ? { chatChain: chain } : {}) });
    onComplete();
  };

  if (statusState.status === "loading" && !isHosted) {
    return (
      <div className="mx-auto flex min-h-[50vh] w-full max-w-5xl items-center justify-center">
        <Spinner size={32} />
      </div>
    );
  }

  if (statusState.status === "error" && !isHosted) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8">
        <Card className="flex flex-col items-start gap-3 p-6" role="alert">
          <div>
            <p className="text-sm font-medium text-text">Could not load configuration</p>
            <p className="text-caption text-text-secondary">{statusState.message}</p>
          </div>
          <Button variant="ghost" onClick={loadStatus}>Retry</Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:py-12 md:flex-row md:gap-10">
      <Stepper steps={steps} step={step} onJump={(index) => index < step && go(index)} onExit={onExit} />

      <div className="min-w-0 flex-1">
        {/* Fade (no slide/remount jump) over a reserved min-height so the next
            step's content never flashes an empty frame during transitions. */}
        <div key={step} className="pcbs-fade-in min-h-[50vh]">
          {isHosted ? (
            <>
              {step === 0 ? (
                <section className="flex flex-col gap-6">
                  <StepHeader title="Choose your region">
                    Retailers, prices and currency follow the region you pick. You can change it later in Settings.
                  </StepHeader>

                  <MarketPreferenceSection heading={false} />

                  <div className="flex items-center justify-end border-t border-border pt-4">
                    <Button iconRight={ArrowRight} onClick={() => go(1)}>
                      Continue
                    </Button>
                  </div>
                </section>
              ) : null}
              {step === 1 ? <StepHostedModel onBack={() => go(0)} onFinish={finish} /> : null}
            </>
          ) : (
            <>
              {step === 0 ? (
                <StepDataSource
                  statusState={statusState}
                  choice={dataSource}
                  onChoose={setDataSource}
                  onRetry={loadStatus}
                  onNext={() => go(1)}
                />
              ) : null}
              {steps[step] === "Fetch data" ? <StepScrape onBack={() => go(0)} onNext={() => go(step + 1)} /> : null}
              {steps[step] === "AI model" ? (
                <StepLLM
                  chain={chain}
                  onChange={setChain}
                  credentials={credentials}
                  endpointState={endpointState}
                  onRetryEndpoints={loadEndpoints}
                  onBack={() => go(step - 1)}
                  onNext={finish}
                  canAdvance={primaryReady}
                />
              ) : null}
            </>
          )}
        </div>

      </div>
    </div>
  );
}

function Stepper({
  steps,
  step,
  onJump,
  onExit
}: {
  steps: string[];
  step: number;
  onJump: (index: number) => void;
  onExit?: () => void;
}) {
  return (
    <nav aria-label="Setup progress" className="md:w-48 md:shrink-0">
      {onExit ? (
        <button
          type="button"
          onClick={onExit}
          className="mb-4 inline-flex items-center gap-1.5 rounded-btn text-sm text-text-secondary hover:text-text"
        >
          <Icon icon={ArrowLeft} size={14} />
          Back to overview
        </button>
      ) : null}
      {/* Mobile: a short bar per step and the current step's name */}
      <ol className="flex items-center gap-1.5 md:hidden">
        {steps.map((label, index) => (
          <li
            key={label}
            className={cn("h-1 w-6 rounded-pill", index <= step ? "bg-accent" : "bg-border")}
            aria-hidden
          />
        ))}
        <li className="ml-2 text-caption text-text-secondary">
          Step {step + 1} of {steps.length}: {steps[step]}
        </li>
      </ol>

      {/* Desktop: a rail of numbered nodes. Done steps can be revisited. */}
      <ol className="hidden flex-col md:flex">
        {steps.map((label, index) => {
          const done = index < step;
          const current = index === step;
          return (
            <li key={label} className="relative pb-6 last:pb-0">
              {index < steps.length - 1 ? (
                <span
                  aria-hidden
                  className={cn("absolute bottom-0 left-[19px] top-9 w-px", done ? "bg-accent" : "bg-border")}
                />
              ) : null}
              <button
                type="button"
                disabled={!done}
                onClick={() => onJump(index)}
                aria-current={current ? "step" : undefined}
                className={cn(
                  "flex w-full items-center gap-3 rounded-btn px-2 py-1.5 text-left text-sm transition-colors duration-150",
                  done ? "text-text-secondary hover:bg-surface-raised hover:text-text" : current ? "font-medium text-text" : "text-text-muted"
                )}
              >
                <span
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-pill border font-mono text-caption",
                    current
                      ? "border-accent bg-bg text-accent ring-4 ring-accent/15"
                      : done
                        ? "border-accent bg-accent text-on-accent"
                        : "border-border bg-bg"
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
