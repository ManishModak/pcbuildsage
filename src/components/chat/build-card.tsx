"use client";

import { useState } from "react";
import { ExternalLink, FlaskConical } from "lucide-react";
import { formatPrice, sumPrices } from "../lib/format";
import { Icon } from "../ui/icon";
import { PillTabs } from "../ui/pill-tabs";
import { StatusBadge } from "../ui/status-badge";
import type { DerivedBuild } from "./build-derive";
import { validationStrip } from "./build-derive";

// The flagship artifact. One card per proposed build, presented as pill tabs
// above a shared card body. Tab labels name the tradeoff each build makes and
// come from the model via validate_build. Prices are mono, right-aligned, tabular.
export function BuildCard({ builds }: { builds: DerivedBuild[] }) {
  const [index, setIndex] = useState(0);
  const active = builds[Math.min(index, builds.length - 1)];
  if (!active) return null;

  const tabs = builds.map((build, i) => ({
    value: String(i),
    label: build.label ?? `Build ${i + 1}`
  }));
  const total = sumPrices(active.components.map((component) => component.price));
  const strip = validationStrip(active.validation);

  return (
    <section className="my-3 overflow-hidden rounded-card border border-border bg-surface" aria-label="Proposed build">
      {tabs.length > 1 ? (
        <div className="border-b border-border px-4 pt-4">
          <PillTabs
            tabs={tabs}
            value={String(Math.min(index, builds.length - 1))}
            onChange={(value) => setIndex(Number(value))}
            ariaLabel="Build strategy"
          />
        </div>
      ) : (
        <div className="border-b border-border px-4 py-3">
          <span className="inline-flex items-center rounded-pill bg-surface-raised px-3 py-1 text-caption font-medium text-text-secondary">
            {active.label ?? "Proposed build"}
          </span>
        </div>
      )}

      <div className="px-4 py-3">
        <ul className="flex flex-col">
          {active.components.map((component) => (
            <li
              key={`${component.category}-${component.name}`}
              className="flex items-baseline gap-3 border-b border-border py-2.5 last:border-b-0"
            >
              <span className="w-24 shrink-0 text-caption font-medium uppercase tracking-wide text-text-muted">
                {component.categoryLabel}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-text">{component.name}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                  {component.retailer ? (
                    component.url ? (
                      <a
                        href={component.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-caption text-accent hover:underline"
                      >
                        {component.retailer}
                        <Icon icon={ExternalLink} size={12} />
                      </a>
                    ) : (
                      <span className="text-caption text-text-secondary">{component.retailer}</span>
                    )
                  ) : (
                    <span className="text-caption text-text-muted">no local listing</span>
                  )}
                  {component.unverified ? (
                    <span
                      className="inline-flex items-center gap-1 text-caption"
                      style={{ color: "var(--unverified)" }}
                      title={component.unverifiedNote}
                    >
                      <Icon icon={FlaskConical} size={12} />
                      {component.unverifiedNote ?? "unverified specs"}
                    </span>
                  ) : null}
                </span>
              </span>
              <span className="shrink-0 font-mono text-sm text-text">
                {formatPrice(component.price, component.currency)}
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
          <span className="text-caption font-medium uppercase tracking-wide text-text-secondary">Total</span>
          <span className="font-mono text-[22px] leading-none text-text">{formatPrice(total, active.currency)}</span>
        </div>

        {strip.length ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {strip.map((badge, i) => (
              <StatusBadge key={i} kind={badge.kind} label={badge.label} title={badge.title} />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
