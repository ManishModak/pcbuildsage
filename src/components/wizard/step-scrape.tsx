"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Database,
  HardDriveDownload,
  Play
} from "lucide-react";
import { useApp } from "../app/app-provider";
import { postSse } from "../lib/api";
import type { StatusResponse } from "../lib/types";
import { Icon } from "../ui/icon";
import { Button, Card } from "../ui/primitives";
import type { DataSourceChoice } from "./step-data-source";
import { ScrapeForm } from "./scrape-form";

export function StepScrape({
  dataSource,
  onBack,
  onNext
}: {
  dataSource: DataSourceChoice | null;
  status: StatusResponse | null;
  onBack: () => void;
  onNext: () => void;
}) {
  if (dataSource === "existing") {
    return (
      <SimplePanel
        icon={Database}
        title="Using your existing database"
        description="Your local product data is ready. You can re-scrape later from settings whenever prices go stale."
        onBack={onBack}
        onNext={onNext}
      />
    );
  }
  if (dataSource === "seed") {
    return <SeedPanel onBack={onBack} onNext={onNext} />;
  }
  return <ScrapeForm onBack={onBack} onNext={onNext} />;
}

function SimplePanel({
  icon,
  title,
  description,
  onBack,
  onNext
}: {
  icon: typeof Database;
  title: string;
  description: string;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <section className="flex flex-col gap-6">
      <div className="flex items-start gap-4 rounded-card border border-border bg-surface p-5">
        <span className="flex h-10 w-10 items-center justify-center rounded-btn border border-border text-accent">
          <Icon icon={icon} size={20} />
        </span>
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-text">{title}</h1>
          <p className="text-sm text-text-secondary">{description}</p>
        </div>
      </div>
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

function SeedPanel({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const { config } = useApp();
  const country = config.countryCode;
  const [messages, setMessages] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const start = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setRunning(true);
    setStarted(true);
    setMessages([]);
    try {
      await postSse(
        "/api/seed",
        { country: country ?? config.countryCode },
        (_event, data) => {
          const message = (data as { message?: string }).message;
          if (message) setMessages((prev) => [...prev, message]);
        },
        controller.signal
      );
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessages((prev) => [...prev, (error as Error).message]);
      }
    } finally {
      if (!controller.signal.aborted) {
        setRunning(false);
      }
    }
  };

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

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
