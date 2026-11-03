"use client";

import { AlertCircle, ExternalLink, FlaskConical } from "lucide-react";
import { formatPrice, formatRetailerName } from "@/lib/format";
import { Icon } from "@/components/ui/icon";
import { StatusBadge } from "@/components/ui/status-badge";
import { resolveBuildTotal, type BuildComponent, type DerivedBuild } from "./build-derive";
import { validationStrip } from "./validation-strip";

export type CompareRow = {
  category: string;
  label: string;
  /** Each build's parts in this category, in build order (empty when it has none). */
  parts: BuildComponent[][];
  /** Every build picked exactly the same parts here. */
  same: boolean;
};

export type BuildComparison = {
  rows: CompareRow[];
  totals: Array<number | null>;
  /** How much more each build costs than the cheapest; all null when the totals can't be compared. */
  deltas: Array<number | null>;
};

function partKey(part: BuildComponent): string {
  return part.productId ?? part.registryKey ?? part.name.trim().toLowerCase();
}

/**
 * Lines up several builds by category, in the order the categories first
 * appear, and marks the categories where every build chose the same parts.
 */
export function compareBuilds(builds: DerivedBuild[]): BuildComparison {
  const labels = new Map<string, string>();
  for (const build of builds) {
    for (const component of build.components) {
      if (!labels.has(component.category)) labels.set(component.category, component.categoryLabel);
    }
  }
  const rows = [...labels].map(([category, label]) => {
    const parts = builds.map((build) => build.components.filter((c) => c.category === category));
    const keys = parts.map((list) => list.map(partKey).sort().join("|"));
    return { category, label, parts, same: keys.every((key) => key === keys[0]) };
  });
  const totals = builds.map(resolveBuildTotal);
  const comparable =
    totals.every((total) => total !== null) && builds.every((build) => build.currency === builds[0]?.currency);
  const lowest = comparable ? Math.min(...(totals as number[])) : 0;
  const deltas = totals.map((total) => (comparable ? (total as number) - lowest : null));
  return { rows, totals, deltas };
}

/**
 * The build card's Compare tab: proposed builds side by side, one column each,
 * with the categories they share collapsed to one line so the differences
 * stand out. Picking a build's name opens that build's own tab.
 */
export function BuildCompare({ builds, onPick }: { builds: DerivedBuild[]; onPick: (index: number) => void }) {
  const { rows, totals, deltas } = compareBuilds(builds);
  const columns = builds.length;
  return (
    <div className="overflow-x-auto">
      <table className="w-full table-fixed border-collapse text-left" style={{ minWidth: `${columns * 9}rem` }}>
        <caption className="sr-only">Proposed builds side by side</caption>
        <thead>
          <tr>
            {builds.map((build, i) => {
              const verdict = validationStrip(build.validation)[0];
              const delta = deltas[i];
              return (
                <th key={i} scope="col" className="px-3 pb-3 pt-4 align-top font-normal first:pl-4 last:pr-4">
                  <button
                    type="button"
                    onClick={() => onPick(i)}
                    className="type-title cursor-pointer text-left text-base text-text hover:text-accent hover:underline"
                  >
                    {build.label ?? `Build ${i + 1}`}
                  </button>
                  <span className="mt-1 block whitespace-nowrap font-mono text-base leading-tight text-text">
                    {formatPrice(totals[i], build.currency)}
                  </span>
                  {delta !== null ? (
                    <span className="block text-caption text-text-muted">
                      {delta === 0 ? "Lowest total" : `${formatPrice(delta, build.currency)} more`}
                    </span>
                  ) : null}
                  {verdict ? (
                    <span className="mt-2 block">
                      {/* Long verdicts ("5 checks passed · 2 unverified") wrap inside their column. */}
                      <StatusBadge
                        kind={verdict.kind}
                        label={verdict.label}
                        title={verdict.title}
                        className="max-w-full rounded-btn [&_span]:whitespace-normal"
                      />
                    </span>
                  ) : null}
                </th>
              );
            })}
          </tr>
        </thead>
        {rows.map((row) => (
          <tbody key={row.category} className="border-t border-dashed border-border">
            <tr>
              <th colSpan={columns} scope="rowgroup" className="type-label px-4 pt-3 text-caption font-normal text-text-muted">
                {row.same && columns > 1 ? `${row.label} · same in every build` : row.label}
              </th>
            </tr>
            <tr>
              {row.same ? (
                <td colSpan={columns} className="px-4 pb-3 align-top">
                  <PartList parts={row.parts[0]} />
                </td>
              ) : (
                row.parts.map((parts, i) => (
                  <td key={i} className="px-3 pb-3 align-top first:pl-4 last:pr-4">
                    {parts.length > 0 ? (
                      <PartList parts={parts} />
                    ) : (
                      <span className="text-caption italic text-text-muted">None</span>
                    )}
                  </td>
                ))
              )}
            </tr>
          </tbody>
        ))}
      </table>
    </div>
  );
}

function PartList({ parts }: { parts: BuildComponent[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {parts.map((part, i) => (
        <li key={`${i}-${part.name}`} className="min-w-0">
          <span className="block text-sm leading-snug text-text">{part.name}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono text-caption text-text">{formatPrice(part.price, part.currency)}</span>
            {part.retailer ? (
              part.url ? (
                <a
                  href={part.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-caption text-accent hover:underline"
                >
                  {formatRetailerName(part.retailer)}
                  <Icon icon={ExternalLink} size={12} />
                </a>
              ) : (
                <span className="text-caption text-text-secondary">{formatRetailerName(part.retailer)}</span>
              )
            ) : null}
            {part.failed ? (
              <span className="inline-flex items-center gap-1 text-caption" style={{ color: "var(--warn)" }}>
                <Icon icon={AlertCircle} size={12} />
                {part.failedNote ?? "Incompatible"}
              </span>
            ) : part.unverified ? (
              <span className="inline-flex items-center gap-1 text-caption" style={{ color: "var(--unverified)" }}>
                <Icon icon={FlaskConical} size={12} />
                {part.unverifiedNote ?? "unverified specs"}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
