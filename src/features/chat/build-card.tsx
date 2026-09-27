"use client";

import { useState, useId } from "react";
import { AlertCircle, ExternalLink, FlaskConical } from "lucide-react";
import { formatPrice } from "@/lib/format";
import { Icon } from "@/components/ui/icon";
import { PillTabs } from "@/components/ui/pill-tabs";
import { StatusBadge } from "@/components/ui/status-badge";
import { cn } from "@/components/ui/cn";
import type { DerivedBuild, BuildVersion } from "./build-derive";
import { resolveBuildTotal, validationStrip } from "./build-derive";

export interface BuildCardProps {
  builds?: DerivedBuild[];
  versions?: BuildVersion[];
  /**
   * Selected version, by stable id rather than by number: an edit or a
   * truncation renumbers the versions, and a number can then point at a
   * different build than the one the user picked.
   */
  selectedVersionId?: string;
  onVersionChange?: (versionId: string) => void;
  selectedAlternativeIndex?: number;
  onAlternativeChange?: (index: number) => void;
  inSidePanel?: boolean;
}

// The flagship artifact. One card per proposed build, presented as pill tabs
// above a shared card body. Tab labels name the tradeoff each build makes and
// come from the model via validate_build. Prices are mono, right-aligned, tabular.
export function BuildCard({
  builds,
  versions,
  selectedVersionId,
  onVersionChange,
  selectedAlternativeIndex,
  onAlternativeChange,
  inSidePanel = false
}: BuildCardProps) {
  const selectId = useId();

  const availableVersions = versions ?? [];
  const latestVersion = availableVersions.length > 0 ? availableVersions[availableVersions.length - 1] : undefined;

  const [internalVersionId, setInternalVersionId] = useState<string | undefined>(undefined);
  const requestedId = selectedVersionId ?? internalVersionId;
  // A selection can outlive the version it named (the transcript was edited or
  // truncated), so fall back to the latest instead of rendering nothing.
  const currentVersionObj =
    (requestedId ? availableVersions.find((v) => v.id === requestedId) : undefined) ??
    latestVersion ??
    undefined;
  const activeVersionNum = currentVersionObj?.version ?? 1;
  const activeBuilds = currentVersionObj?.builds ?? builds ?? [];

  const [prevVersionId, setPrevVersionId] = useState(currentVersionObj?.id);
  const [internalIndex, setInternalIndex] = useState(0);

  // Clean state adjustment on version change during render (standard React pattern)
  if (prevVersionId !== currentVersionObj?.id) {
    setPrevVersionId(currentVersionObj?.id);
    setInternalIndex(0);
  }

  const index = selectedAlternativeIndex ?? internalIndex;

  const setIndex = (newIndex: number) => {
    setInternalIndex(newIndex);
    onAlternativeChange?.(newIndex);
  };

  const safeIndex = Math.min(Math.max(0, index), Math.max(0, activeBuilds.length - 1));
  const active = activeBuilds[safeIndex];
  if (!active) return null;

  // The turn said a build existed but nothing renderable came with it. Say so
  // instead of showing an empty card with a made-up total.
  if (active.detailsUnavailable || active.components.length === 0) {
    return (
      <section
        className={cn(
          "overflow-hidden rounded-card border border-border bg-surface",
          !inSidePanel && "my-3"
        )}
        aria-label="Proposed build"
      >
        <div className="px-4 py-4">
          {active.label ? (
            <span className="inline-flex items-center rounded-pill bg-surface-raised px-3 py-1 text-caption font-medium text-text-secondary">
              {active.label}
            </span>
          ) : null}
          <p className="mt-3 text-sm text-text-secondary">
            {"Build details unavailable \u2014 ask the assistant to present it again"}
          </p>
        </div>
      </section>
    );
  }

  const tabs = activeBuilds.map((build, i) => ({
    value: String(i),
    label: build.label ?? `Build ${i + 1}`
  }));
  const total = resolveBuildTotal(active);
  const strip = validationStrip(active.validation);

  return (
    <section
      className={cn(
        "overflow-hidden rounded-card border border-border bg-surface",
        !inSidePanel && "my-3"
      )}
      aria-label="Proposed build"
    >
      {availableVersions.length > 1 ? (
        <div className="flex items-center justify-between border-b border-border bg-surface-raised/40 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-caption font-medium text-text-secondary">
              Build Version
            </span>
            <span className="rounded-pill bg-surface border border-border px-2 py-0.5 text-[11px] font-mono font-medium text-text-muted">
              v{activeVersionNum} of {availableVersions.length}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor={selectId} className="sr-only">
              Previous versions
            </label>
            <select
              id={selectId}
              aria-label="Previous versions"
              value={currentVersionObj?.id ?? ""}
              onChange={(e) => {
                const nextId = e.target.value;
                setInternalVersionId(nextId);
                setIndex(0);
                onVersionChange?.(nextId);
              }}
              className="rounded-btn border border-border bg-surface px-2.5 py-1 text-caption font-medium text-text hover:border-accent focus:border-accent focus:outline-none cursor-pointer"
            >
              {availableVersions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v === latestVersion ? `${v.label} (Latest)` : v.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      {tabs.length > 1 ? (
        <div className="border-b border-border px-4 pt-4">
          <PillTabs
            tabs={tabs}
            value={String(safeIndex)}
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
          {active.components.map((component, componentIndex) => (
            <li
              // Two identical parts in one category are legal (a matched pair
              // of sticks, say), so the key needs the position too.
              key={`${componentIndex}-${component.category}-${component.name}`}
              className="flex items-baseline gap-3 border-b border-border py-2.5 last:border-b-0"
            >
              <span className="w-24 shrink-0 text-caption font-medium uppercase tracking-wide text-text-muted">
                {component.categoryLabel}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-text">{component.name}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                  {component.notInCatalog ? (
                    <span className="inline-flex flex-wrap items-baseline gap-x-2 text-caption text-text-muted">
                      <span className="italic">not in catalog</span>
                      {/* The id belongs here, not in the name above it. */}
                      {component.productId ? (
                        <span className="font-mono text-[11px]">{component.productId}</span>
                      ) : null}
                    </span>
                  ) : component.retailer ? (
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
                    <span className="text-caption text-text-muted italic">Derived requirement</span>
                  )}
                  {component.failed ? (
                    <span
                      className="inline-flex items-center gap-1 text-caption text-warn"
                      style={{ color: "var(--warn)" }}
                      title={component.failedNote}
                    >
                      <Icon icon={AlertCircle} size={12} />
                      {component.failedNote ?? "Incompatible"}
                    </span>
                  ) : component.unverified ? (
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
