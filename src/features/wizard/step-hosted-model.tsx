"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useApp } from "@/components/app/app-provider";
import { probeEntry } from "@/lib/api-client";
import { getErrorMessage } from "@/lib/format";
import { getByokKey, hasByokKey } from "@/lib/llm/client-byok-store";
import type { LLMProvider, PingResult } from "@/types/client";
import { Button } from "@/components/ui/primitives";
import { ByokSection } from "@/features/settings/byok-section";
import { ProbeResultView } from "@/features/llm/probe-result-view";
import { hostedByokCanAdvance, hostedProbeIsCurrent, isHostedByokProvider } from "./hosted-gating";
import { StepHeader } from "./simple-panel";

type Selection = { provider: string; model: string };

/**
 * Hosted onboarding's last step: paste a free key, pick a model, then one
 * button checks it with /api/llm/probe and finishes setup only when the model
 * answered and can use tools. A failed check says why in plain words.
 */
export function StepHostedModel({ onBack, onFinish }: { onBack: () => void; onFinish: () => void }) {
  const { config, updateConfig } = useApp();
  const [probe, setProbe] = useState<PingResult | null>(null);
  const [probedFor, setProbedFor] = useState<Selection | null>(null);
  const [checking, setChecking] = useState(false);
  // Keys live in session storage, outside React state: bump this on save or
  // clear so hasKey below is read again.
  const [, setKeyEpoch] = useState(0);

  const configRef = useRef(config);
  const mountedRef = useRef(false);
  useEffect(() => {
    configRef.current = config;
  });
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ByokSection keeps config.chatChain[0] on the provider and model the chat will use.
  const first = config.chatChain[0];
  const entry = first && isHostedByokProvider(first.provider) ? first : null;
  const hasKey = entry ? hasByokKey(entry.provider) : false;
  const selection = entry ? { provider: entry.provider, model: entry.model } : null;
  const probeCurrent = hostedProbeIsCurrent(probe, probedFor, selection);
  const passed = Boolean(entry?.model && hasKey && probeCurrent && hostedByokCanAdvance(probe));

  const blockedReason = !entry || !hasKey
    ? "Paste your API key above to continue."
    : !entry.model
      ? "Pick a model above to continue."
      : null;

  const resetProbe = () => {
    setProbe(null);
    setProbedFor(null);
  };

  const checkAndContinue = async () => {
    // A check that already passed for this key and model is not repeated:
    // each one spends a request from the user's free quota.
    if (passed) {
      onFinish();
      return;
    }
    const target = configRef.current.chatChain[0];
    if (!target || !isHostedByokProvider(target.provider) || !target.model) return;
    const key = getByokKey(target.provider);
    if (!key) return;

    setChecking(true);
    let result: PingResult;
    try {
      result = await probeEntry({ provider: target.provider as LLMProvider, model: target.model, keySource: "ui" }, key);
    } catch (error) {
      result = { reachable: false, latencyMs: 0, toolCapable: false, hint: getErrorMessage(error) };
    }
    if (!mountedRef.current) return;
    setChecking(false);

    // The user may have left, or changed the key or model, while the check
    // ran: that result no longer describes anything on screen.
    const now = configRef.current.chatChain[0];
    if (!now || now.provider !== target.provider || now.model !== target.model || getByokKey(target.provider) !== key) {
      return;
    }
    setProbe(result);
    setProbedFor({ provider: target.provider, model: target.model });
    if (!hostedByokCanAdvance(result)) return;

    updateConfig((prev) => ({
      ...prev,
      chatChain: prev.chatChain.map((item, index) => (index === 0 ? { ...item, ping: result } : item))
    }));
    onFinish();
  };

  return (
    <section className="flex flex-col gap-6">
      <StepHeader title="Connect an AI model">
        PCBuildSage asks an AI model of your choice to plan the build, using your own key. Google Gemini and
        OpenRouter both give free keys, and getting one takes about a minute.{" "}
        <Link href="/help/api-key" className="font-medium text-accent hover:underline">
          Step-by-step key guide
        </Link>
      </StepHeader>

      <ByokSection
        variant="onboarding"
        // Saving or clearing a key, or picking another model, makes the last
        // check stale: the button must check again.
        onKeyChange={() => {
          resetProbe();
          setKeyEpoch((epoch) => epoch + 1);
        }}
        onModelChange={(provider, model, contextLimit) => {
          resetProbe();
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

      <div className="flex flex-col gap-3 border-t border-border pt-4">
        {probeCurrent && probe && !passed ? <ProbeResultView ping={probe} /> : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button variant="ghost" iconLeft={ArrowLeft} onClick={onBack}>
            Back
          </Button>
          <div className="flex flex-wrap items-center justify-end gap-3">
            {blockedReason ? (
              <span className="text-caption text-text-muted" data-testid="hosted-continue-reason">
                {blockedReason}
              </span>
            ) : null}
            <Button
              iconRight={ArrowRight}
              loading={checking}
              disabled={Boolean(blockedReason)}
              onClick={() => void checkAndContinue()}
            >
              {checking ? "Checking your key…" : "Check key and continue"}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
