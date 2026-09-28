"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Radio } from "lucide-react";
import { useApp } from "@/components/app/app-provider";
import { fetchCredentials, fetchEndpoints, fetchMarkets, fetchStatus, isHostedMode, probeEntry } from "@/lib/api-client";
import { getErrorMessage } from "@/lib/format";
import type { ChainEntry, CredentialAvailability, LLMProvider, MarketMetadata, PingResult } from "@/types/client";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icon";
import { Button, Card, Spinner } from "@/components/ui/primitives";
import { MarketPreferenceSection } from "@/features/settings/market-preference-section";
import { ByokSection } from "@/features/settings/byok-section";
import { getByokKey, hasByokKey } from "@/lib/llm/client-byok-store";
import { setMarketPreference } from "@/lib/market/client-market-store";
import { StepChat } from "./step-chat";
import { StepDataSource, type DataSourceChoice, type StatusLoadState } from "./step-data-source";
import { StepLLM, type EndpointLoadState } from "./step-llm";
import { StepScrape } from "./step-scrape";
import { hostedByokCanAdvance, hostedProbeIsCurrent, isHostedByokProvider, shouldSkipMarketStep } from "./hosted-gating";

const LOCAL_STEPS = ["Data source", "Fetch data", "AI providers", "Personalize"];
const HOSTED_STEPS = ["Market", "AI Provider", "Personalize"];

export function Wizard({ onComplete }: { onComplete: () => void }) {
  const { config, updateConfig } = useApp();
  const [step, setStep] = useState(0);

  const [statusState, setStatusState] = useState<StatusLoadState>({ status: "loading" });
  const [credentials, setCredentials] = useState<CredentialAvailability | null>(null);
  const [endpointState, setEndpointState] = useState<EndpointLoadState>({ status: "loading" });
  const [dataSource, setDataSource] = useState<DataSourceChoice | null>(null);
  const [chain, setChain] = useState<ChainEntry[]>(config.chatChain);
  const [markets, setMarkets] = useState<MarketMetadata[] | null>(null);

  // Hosted BYOK gate: key + chosen model must pass the /api/llm/probe check
  // (reachable + tool-capable) before Continue unlocks.
  const [hostedProbe, setHostedProbe] = useState<PingResult | null>(null);
  const [hostedProbedFor, setHostedProbedFor] = useState<{ provider: string; model: string } | null>(null);
  const [hostedProbing, setHostedProbing] = useState(false);
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  });

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

  const steps = isHosted ? HOSTED_STEPS : LOCAL_STEPS;

  const go = (next: number) => {
    setStep(next);
  };

  // Skip the market step when a single market leaves nothing to choose.
  useEffect(() => {
    if (!isHosted || step !== 0 || !markets || !shouldSkipMarketStep(markets)) return;
    const only = markets[0];
    const updated = setMarketPreference({
      countryCode: only.code,
      currencyCode: only.defaultCurrency,
      locale: only.locale
    });
    updateConfig({ countryCode: updated.countryCode, currency: updated.currencyCode });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-way auto-skip on first eligible paint
    setStep(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-way auto-skip on first eligible paint
  }, [isHosted, step, markets]);

  const primary = chain[0];
  const primaryReady = Boolean(primary?.model) && Boolean(primary?.ping?.toolCapable);

  // Hosted BYOK selection: ByokSection keeps config.chatChain current via onModelChange.
  const hostedEntry = config.chatChain[0] && isHostedByokProvider(config.chatChain[0].provider)
    ? config.chatChain[0]
    : null;
  const hostedSelection = hostedEntry ? { provider: hostedEntry.provider, model: hostedEntry.model } : null;
  const hostedHasKey = hostedEntry ? hasByokKey(hostedEntry.provider) : false;
  const hostedProbeCurrent =
    hostedEntry && hostedProbeIsCurrent(hostedProbe, hostedProbedFor, hostedSelection);
  const hostedReady = Boolean(
    hostedEntry?.model && hostedHasKey && hostedProbeCurrent && hostedByokCanAdvance(hostedProbe)
  );

  const runHostedProbe = useCallback(async () => {
    const entry = configRef.current.chatChain[0];
    if (!entry || !isHostedByokProvider(entry.provider) || !entry.model) return;
    const key = getByokKey(entry.provider);
    if (!key) return;
    setHostedProbing(true);
    try {
      const result = await probeEntry(
        { provider: entry.provider as LLMProvider, model: entry.model, keySource: "ui" },
        key
      );
      setHostedProbe(result);
      setHostedProbedFor({ provider: entry.provider, model: entry.model });
      if (result.reachable && result.toolCapable) {
        const current = configRef.current;
        updateConfig({
          chatChain: current.chatChain.map((item, index) =>
            index === 0 ? { ...item, ping: result } : item
          )
        });
      }
    } catch (error) {
      setHostedProbe({
        reachable: false,
        latencyMs: 0,
        toolCapable: false,
        hint: getErrorMessage(error instanceof Error ? error : new Error(String(error)))
      });
      setHostedProbedFor({ provider: entry.provider, model: entry.model });
    } finally {
      setHostedProbing(false);
    }
  }, [updateConfig]);

  const canAdvance = useMemo(() => {
    if (isHosted) return step === 1 ? hostedReady : true;
    if (step === 0) return dataSource !== null;
    if (step === 2) return primaryReady;
    return true;
  }, [isHosted, step, dataSource, primaryReady, hostedReady]);

  const finish = () => {
    // Hosted: the chain is maintained by ByokSection via onModelChange and the
    // BYOK step gate guarantees a probed, tool-capable entry. Never finish
    // without it — the first message would otherwise fail.
    if (isHosted && !hostedReady) return;
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
      <Stepper steps={steps} step={step} onJump={(index) => index < step && go(index)} />

      <div className="min-w-0 flex-1">
        {/* Fade (no slide/remount jump) over a reserved min-height so the next
            step's content never flashes an empty frame during transitions. */}
        <div key={step} className="pcbs-fade-in min-h-[50vh]">
          {isHosted ? (
            <>
              {step === 0 ? (
                <section className="flex flex-col gap-6">
                  <header className="flex flex-col gap-1">
                    <h1 className="text-2xl font-semibold text-text">Choose your market</h1>
                    <p className="text-base text-text-secondary">
                      PCBuildSage queries live hardware offers tailored to your region. Select your country and native currency.
                    </p>
                  </header>

                  <Card className="p-5">
                    <MarketPreferenceSection />
                  </Card>

                  <div className="flex items-center justify-end border-t border-border pt-4">
                    <Button iconRight={ArrowRight} onClick={() => go(1)}>
                      Continue to AI Provider
                    </Button>
                  </div>
                </section>
              ) : null}

              {step === 1 ? (
                <section className="flex flex-col gap-6">
                  <header className="flex flex-col gap-1">
                    <h1 className="text-2xl font-semibold text-text">Connect your AI model (BYOK)</h1>
                    <p className="text-base text-text-secondary">
                      Bring your own Gemini or OpenRouter API key. Keys stay securely in your browser session and are never saved to our server or database.
                    </p>
                  </header>

                  <ByokSection
                    onModelChange={(provider, model, contextLimit) => {
                      setHostedProbe(null);
                      setHostedProbedFor(null);
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

                  <div className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface px-3 py-2.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      iconLeft={Radio}
                      onClick={() => void runHostedProbe()}
                      disabled={hostedProbing || !hostedEntry?.model || !hostedHasKey}
                    >
                      {hostedProbing ? "Verifying…" : "Ping & probe tools"}
                    </Button>
                    {hostedProbing ? <Spinner size={14} /> : null}
                    {hostedProbeCurrent && hostedProbe ? (
                      hostedProbe.reachable && hostedProbe.toolCapable ? (
                        <span className="text-caption font-medium text-accent" data-testid="hosted-probe-ok">
                          Reachable · tool-capable — you can continue.
                        </span>
                      ) : !hostedProbe.reachable ? (
                        <span className="text-caption font-medium text-warn" data-testid="hosted-probe-fail">
                          Unreachable{hostedProbe.hint ? ` — ${hostedProbe.hint}` : ""}. Check your key and try again.
                        </span>
                      ) : (
                        <span className="text-caption font-medium text-warn" data-testid="hosted-probe-fail">
                          Reachable but no tool support — pick a Recommended model.
                        </span>
                      )
                    ) : null}
                  </div>

                  <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
                    <Button variant="ghost" iconLeft={ArrowLeft} onClick={() => go(0)}>
                      Back
                    </Button>
                    <div className="flex items-center gap-3">
                      {!hostedReady ? (
                        <span className="text-caption text-text-muted" data-testid="hosted-continue-reason">
                          {!hostedEntry || !hostedHasKey
                            ? "Add your API key above to continue."
                            : !hostedEntry.model
                              ? "Pick a model above to continue."
                              : "Run 'Ping & probe tools' first: the model must be reachable and support tool calling."}
                        </span>
                      ) : null}
                      <Button iconRight={ArrowRight} onClick={() => go(2)} disabled={!hostedReady}>
                        Continue
                      </Button>
                    </div>
                  </div>
                </section>
              ) : null}

              {step === 2 ? <StepChat onBack={() => go(1)} onFinish={finish} /> : null}
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
              {step === 1 ? (
                <StepScrape
                  dataSource={dataSource}
                  onBack={() => go(0)}
                  onNext={() => go(2)}
                />
              ) : null}
              {step === 2 ? (
                <StepLLM
                  chain={chain}
                  onChange={setChain}
                  credentials={credentials}
                  endpointState={endpointState}
                  onRetryEndpoints={loadEndpoints}
                  onBack={() => go(1)}
                  onNext={() => go(3)}
                  canAdvance={primaryReady}
                />
              ) : null}
              {step === 3 ? <StepChat onBack={() => go(2)} onFinish={finish} /> : null}
            </>
          )}
        </div>

        {!isHosted && step !== 0 && step !== 3 ? (
          <NavHint canAdvance={canAdvance} step={step} primaryReady={primaryReady} />
        ) : null}
      </div>
    </div>
  );
}

function Stepper({ steps, step, onJump }: { steps: string[]; step: number; onJump: (index: number) => void }) {
  return (
    <nav aria-label="Onboarding progress" className="md:w-44 md:shrink-0">
      {/* Mobile: progress dots */}
      <ol className="flex items-center gap-2 md:hidden">
        {steps.map((label, index) => (
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
        <li className="ml-1 text-caption text-text-secondary">{steps[step]}</li>
      </ol>

      {/* Desktop: left-aligned vertical stepper */}
      <ol className="hidden flex-col gap-1 md:flex">
        {steps.map((label, index) => {
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
