"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, HardDriveDownload, Play } from "lucide-react";
import { useApp } from "../app/app-provider";
import { postSse } from "../lib/api";
import { Icon } from "../ui/icon";
import { Button, Card } from "../ui/primitives";

export function SeedPanel({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const { config } = useApp();
  const country = config.countryCode;
  const [messages, setMessages] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Cancel any in-flight seed download when the step unmounts (navigation away).
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    []
  );

  const start = async () => {
    setRunning(true);
    setStarted(true);
    setMessages([]);
    const controller = new AbortController();
    abortRef.current = controller;
    await postSse("/api/seed", { country: country ?? config.countryCode }, (_event, data) => {
      if (controller.signal.aborted) return;
      const message = (data as { message?: string }).message;
      if (message) setMessages((prev) => [...prev, message]);
    }, controller.signal).catch((error) => {
      if (!controller.signal.aborted) setMessages((prev) => [...prev, (error as Error).message]);
    });
    if (!controller.signal.aborted) setRunning(false);
    abortRef.current = null;
  };

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-text">Download a seed dataset</h1>
        <p className="text-base text-text-secondary">
          Fetch a shared snapshot for {country ?? config.countryCode}. Fastest path to real data.
        </p>
      </header>

      <Card className="p-4">
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-2 text-sm text-text">
            <Icon icon={HardDriveDownload} size={18} className="text-accent" />
            Community seed · {country ?? config.countryCode}
          </span>
          <Button iconLeft={Play} loading={running} onClick={start}>
            {started ? "Retry" : "Download"}
          </Button>
        </div>
        {messages.length ? (
          <ul className="mt-3 flex flex-col gap-1 border-t border-border pt-3 font-mono text-caption text-text-secondary">
            {messages.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
        ) : null}
      </Card>

      <div className="flex items-center justify-between">
        <Button variant="ghost" iconLeft={ArrowLeft} onClick={onBack}>
          Back
        </Button>
        <Button iconRight={ArrowRight} onClick={onNext}>
          Continue
        </Button>
      </div>
    </section>
  );
}
