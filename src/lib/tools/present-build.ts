import { tool } from "ai";
import { z } from "zod";
import {
  createTurnValidationStore,
  normalizeLabel,
  validLabels,
  type TurnValidationEntry,
  type TurnValidationStore
} from "./turn-state";
import { idsMatch, MIN_PREFIX_LEN, resolveIdPrefix, shortId } from "./product-ids";
import { formatPrice, lenientToolSchema, parsedJson } from "./lenient-input";
import { notPurchasableNote, type UnpurchasablePart } from "./validate-build";
import { unnamedOwnedNote } from "./owned-parts";

export const presentBuildInputSchema = z.object({
  builds: parsedJson(z
    .array(
      z.object({
        label: z
          .string()
          .min(1)
          .describe(
            "Tradeoff label matching a validate_build label this turn, e.g. 'Within budget', 'Small upgrade', 'Max Performance'"
          ),
        product_ids: z
          .array(z.string())
          .min(1)
          .optional()
          .describe(
            "Optional catalog product ID prefixes (first 10 chars, min 8) from the matching validate_build snapshot. Omit to present the validated snapshot as-is."
          ),
        notes: z.string().optional().describe("Optional brief description of this build variant")
      })
    )
    .min(1)
    .describe("One or more complete build proposals"))
});

export type PresentBuildInput = z.infer<typeof presentBuildInputSchema>;

/**
 * The validation entry for a presented label: an exact match, else the one
 * validated label the given label starts with as whole words, so decorations
 * such as "AM5 DDR5 Build (Recommended, over budget)" still find "AM5 DDR5
 * Build" (Lightning, r12 video-editing). The longest such label wins.
 */
function findEntry(store: TurnValidationStore, label: string): TurnValidationEntry | undefined {
  const wanted = normalizeLabel(label);
  const exact = store.get(wanted);
  if (exact) return exact;
  let best: TurnValidationEntry | undefined;
  for (const [key, entry] of store) {
    if (!wanted.startsWith(key) || /[\p{L}\p{N}]/u.test(wanted.charAt(key.length))) continue;
    if (!best || key.length > normalizeLabel(best.label).length) best = entry;
  }
  return best;
}

/**
 * The one validated build whose parts are exactly the supplied product IDs,
 * for a present_build label that names no validation. Lightning validated
 * "Build 1" and called present_build five times as "Within budget" with the
 * same IDs, each refused (r37 final, office).
 */
function findEntryByParts(store: TurnValidationStore, supplied: unknown[]): TurnValidationEntry | undefined {
  const ids = supplied.map((raw) => String(raw ?? "").trim()).filter(Boolean);
  if (ids.length === 0) return undefined;
  const matches = [...new Set(store.values())].filter(
    (entry) =>
      entry.productIds.length === ids.length &&
      entry.productIds.every((full) => ids.filter((id) => idsMatch(id, full)).length === 1) &&
      ids.every((id) => entry.productIds.filter((full) => idsMatch(id, full)).length === 1)
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * A presented build. `validation` (with its snapshot) is what the card shows:
 * readers use it instead of matching the label to a validate_build result, since
 * a build validated inside present_build (see `revalidate`) has none in the
 * stream. present_build's model view drops it.
 */
type Presented = {
  label: string;
  /** The validate_build label, when the build is shown under another (see shownLabel). */
  validated_label?: string;
  product_ids: string[];
  notes?: string;
  validation: TurnValidationEntry["validation"];
};
type Refused = { presented: false; error: string; ids_differ?: true; [key: string]: unknown };

/** Validates `parts` as build `label` into the turn store, as validate_build does. */
export type Revalidate = (label: string, parts: Record<string, unknown>, budget?: number) => Promise<unknown>;

/**
 * Parts for a build made of the given product IDs, when every one is a part
 * some validation this turn resolved or a search this turn returned (`found`:
 * full ID to category), plus the owned parts of `entry`. A supplied ID that
 * `entry` had as owned stays owned (costs 0). Null when an ID is unknown or
 * ambiguous, or two IDs share a single-part category.
 */
function partsFromKnownIds(
  store: TurnValidationStore,
  entry: TurnValidationEntry,
  supplied: readonly string[],
  found: ReadonlyMap<string, string> = new Map()
): Record<string, unknown> | null {
  const known = new Map<string, string>(found);
  for (const e of store.values()) {
    for (const c of e.snapshot?.components ?? []) {
      if (typeof c?.product_id === "string" && typeof c.category === "string") known.set(c.product_id, c.category);
    }
  }
  const owned = (entry.snapshot?.components ?? []).filter((c) => c?.owned && typeof c.category === "string");
  const ownedIds = new Set(owned.map((c) => c.product_id).filter((id): id is string => typeof id === "string"));
  const parts: Record<string, unknown> = {};
  const add = (category: string, part: Record<string, unknown>): boolean => {
    if (category === "storage") parts.storage = [...((parts.storage as unknown[] | undefined) ?? []), part];
    else if (parts[category]) return false;
    else parts[category] = part;
    return true;
  };
  const used = new Set<string>();
  for (const raw of supplied) {
    const pid = String(raw ?? "").trim();
    if (pid.length < MIN_PREFIX_LEN) return null;
    const matches = [...known.keys()].filter((full) => idsMatch(pid, full));
    if (matches.length !== 1) return null;
    used.add(matches[0]);
    if (!add(known.get(matches[0])!, ownedIds.has(matches[0]) ? { product_id: matches[0], owned: true } : { product_id: matches[0] })) return null;
  }
  for (const c of owned) {
    if (c.product_id && used.has(c.product_id)) continue;
    // An owned part fills its slot unless a supplied part took it (storage holds several).
    if (c.category === "storage" || !parts[c.category]) add(c.category, c.product_id ? { product_id: c.product_id, owned: true } : { name: c.name, owned: true });
  }
  return parts;
}

/**
 * Why a validated build can't be presented, or undefined when it can: invalid
 * or blocking issues, an owned part the user never named, a part that can't be
 * bought, or a whole build (it has a motherboard) missing a core part. Upgrade
 * picks without a motherboard (a GPU alone, a drop-in CPU) stay presentable.
 * The chat engine uses the same rules to decide which validations to force.
 */
export function presentRefusal(label: string, validation: TurnValidationEntry["validation"]): Refused | undefined {
  const issues = Array.isArray(validation.issues) ? validation.issues : [];
  const blocking = issues.filter((i) => i?.severity === "blocking");
  if (validation.valid !== true || blocking.length > 0) {
    return {
      presented: false,
      error: `Build '${label}' has blocking compatibility issues and cannot be presented. Resolve them and re-validate.`,
      issues: blocking.map((i) => i.detail ?? i.rule)
    };
  }
  const unnamedOwned = (validation as { unnamed_owned?: string[] }).unnamed_owned;
  if (Array.isArray(unnamedOwned) && unnamedOwned.length > 0) {
    return { presented: false, error: unnamedOwnedNote(unnamedOwned) };
  }
  const unpurchasable = (validation as { not_purchasable?: UnpurchasablePart[] }).not_purchasable;
  if (Array.isArray(unpurchasable) && unpurchasable.length > 0) {
    return { presented: false, error: notPurchasableNote(unpurchasable) };
  }
  const missing = (validation as { missing_parts?: string[] }).missing_parts;
  if (Array.isArray(missing) && missing.length > 0 && !missing.includes("motherboard")) {
    return {
      presented: false,
      error: `Build '${label}' is missing ${missing.join(", ")}. Re-validate it with every part (for a part the user owns, pass {"name":"...","owned":true}), then present it.`
    };
  }
  return undefined;
}

/**
 * Checks one requested build against this turn's validations: the build to
 * present (validated snapshot IDs, or the supplied prefixes when they cover it
 * exactly), or why it can't be presented.
 */
function checkBuild(turnStore: TurnValidationStore, build: PresentBuildInput["builds"][number]): Presented | Refused {
  const byLabel = findEntry(turnStore, build.label);
  const entry = byLabel ?? findEntryByParts(turnStore, Array.isArray(build.product_ids) ? build.product_ids : []);
  if (!entry) {
    const valid = validLabels(turnStore);
    return {
      presented: false,
      error: `No validation this turn for label '${build.label}'. Labels validated this turn: ${valid.length > 0 ? valid.join(", ") : "(none — call validate_build first)"}.`,
      valid_labels: valid
    };
  }
  const refusal = presentRefusal(build.label, entry.validation);
  if (refusal) return refusal;
  // A build found by its parts shows under the requested label, made honest the same way.
  const shown = shownLabel(byLabel ? entry : { ...entry, label: build.label });
  const snapshotIds = entry.productIds;
  const supplied = Array.isArray(build.product_ids) ? build.product_ids : [];
  if (supplied.length === 0) {
    return { ...shown, product_ids: snapshotIds, ...(build.notes ? { notes: build.notes } : {}), validation: entry.validation };
  }
  const resolved: string[] = [];
  for (const raw of supplied) {
    const pid = String(raw ?? "").trim();
    if (!pid) continue;
    if (pid.length < MIN_PREFIX_LEN && !snapshotIds.includes(pid)) {
      return {
        presented: false,
        error: `Product ID '${pid}' is too short (min ${MIN_PREFIX_LEN} chars). Pass at least ${MIN_PREFIX_LEN} chars from the validation snapshot.`
      };
    }
    const matches = snapshotIds.filter((full) => idsMatch(pid, full));
    if (matches.length === 0) {
      return {
        presented: false,
        error: `Product IDs for '${build.label}' differ from its validation snapshot. Expected: ${snapshotIds.map(shortId).join(", ")}.`,
        ids_differ: true
      };
    }
    if (matches.length > 1) {
      const res = resolveIdPrefix(pid, snapshotIds);
      if (!("full" in res)) {
        return { presented: false, error: res.error };
      }
      resolved.push(res.full);
    } else {
      resolved.push(matches[0]);
    }
  }
  // Every snapshot part must be covered exactly once.
  const coversAll =
    resolved.length === snapshotIds.length &&
    snapshotIds.every((full) => resolved.includes(full));
  if (!coversAll) {
    return {
      presented: false,
      error: `Product IDs for '${build.label}' differ from its validation snapshot. Expected: ${snapshotIds.map(shortId).join(", ")}.`,
      ids_differ: true
    };
  }
  return { ...shown, product_ids: resolved, ...(build.notes ? { notes: build.notes } : {}), validation: entry.validation };
}

/**
 * The label a build is shown under: a "Within budget" label over the budget
 * given to validate_build becomes "Closest to budget (₹577 over)". Refusing it
 * left the last step with nothing to show (Lightning r29 office); presenting it
 * as labelled is a false claim (r24 office).
 */
function shownLabel(entry: TurnValidationEntry): { label: string; validated_label?: string } {
  const overBy = (entry.validation as { budget?: { over_by?: unknown } }).budget?.over_by;
  if (typeof overBy !== "number" || overBy <= 0 || !/within budget/i.test(entry.label)) return { label: entry.label };
  const label = `${entry.label.replace(/within budget/gi, "Closest to budget")} (${formatPrice(overBy, entry.snapshot?.currency)} over)`;
  return { label, validated_label: entry.label };
}

/** present_build's result as the model sees it: without each build's validation. */
export function toModelPresentOutput(output: unknown): unknown {
  const builds = (output as { builds?: unknown } | null)?.builds;
  if (!Array.isArray(builds)) return output;
  return {
    ...(output as object),
    builds: builds.map((build) => {
      if (!build || typeof build !== "object") return build;
      return Object.fromEntries(Object.entries(build).filter(([key]) => key !== "validation"));
    })
  };
}

/** Labels of this turn's validations that present_build would accept as they stand, oldest first, at most 5. */
export function presentableLabels(turnStore: TurnValidationStore): string[] {
return [...turnStore.values()]
  .filter((entry) => !("presented" in checkBuild(turnStore, { label: entry.label })))
  .map((entry) => entry.label)
  .slice(0, 5);
}

/**
 * An empty call (no `builds`, or none listed) presents every presentable build
 * validated this turn. The forced last step sends one when a model answers it
 * with text instead of a call (Lightning, r12: validated builds never shown).
 */
function fillEmptyCall(turnStore: TurnValidationStore) {
  return (value: Record<string, unknown>): Record<string, unknown> => {
    const builds = value.builds;
    const empty = builds === undefined || builds === null || (Array.isArray(builds) && builds.length === 0) || builds === "" || builds === "[]";
    if (!empty) return value;
    const labels = presentableLabels(turnStore);
    return labels.length > 0 ? { ...value, builds: labels.map((label) => ({ label })) } : value;
  };
}

/**
 * `revalidate` lets a call whose product_ids differ from the label's snapshot
 * still present, when every ID was validated or found by a search this turn
 * (`found`: full ID to category): those parts are validated together under the
 * label first. Lightning validated GPU, case and cooler in one call and the
 * rest in another, then presented the union (r24 esports and 4K); it also
 * listed a whole build whose CPU it had only searched (r29 esports).
 */
export function createPresentBuildTool(
  store?: TurnValidationStore,
  options?: { revalidate?: Revalidate; found?: ReadonlyMap<string, string> }
) {
  const hasTurnStore = Boolean(store);
  const turnStore = store ?? createTurnValidationStore();
  return tool({
    description:
      "Present one or more complete, finalized PC builds to the user as an interactive visual card with toggle tabs, retailer buy links, and total price calculation. Call this with labels matching validate_build from this turn; product_ids are optional prefixes (first 10 chars, min 8) and default to the validated snapshot. All pricing, retailer links, and totals come authoritatively from the matching validate_build snapshot. Do NOT repeat a markdown table of parts/prices in your text response.",
    inputSchema: lenientToolSchema(
      presentBuildInputSchema,
      "present_build",
      'Pass builds as a JSON array (not a string) of objects whose label matches a validate_build label from this turn. Example: {"builds":[{"label":"Within budget"},{"label":"Small upgrade"}]}',
      fillEmptyCall(turnStore)
    ),
    execute: async (input) => {
      // Isolated usage (no turn store): preserve legacy pass-through for
      // saved chats and direct calls. Registry wiring enforces validation.
      if (!hasTurnStore && turnStore.size === 0) {
        return {
          presented: true,
          buildCount: input.builds.length,
          builds: input.builds
        };
      }
      const presented: Presented[] = [];
      const refused: Array<{ label: string; failure: Refused }> = [];
      for (const build of input.builds) {
        let outcome = checkBuild(turnStore, build);
        const entry = findEntry(turnStore, build.label);
        if ("presented" in outcome && outcome.ids_differ && options?.revalidate && entry && build.product_ids) {
          const parts = partsFromKnownIds(turnStore, entry, build.product_ids, options?.found);
          if (parts) {
            const target = (entry.validation as { budget?: { target?: unknown } }).budget?.target;
            await options.revalidate(entry.label, parts, typeof target === "number" ? target : undefined);
            outcome = checkBuild(turnStore, { label: entry.label, ...(build.notes ? { notes: build.notes } : {}) });
          }
        }
        if ("presented" in outcome) refused.push({ label: build.label, failure: outcome });
        else presented.push(outcome);
      }
      // Nothing presentable: the first refusal, naming the builds that are
      // ready (Lightning r17 cheapest-gta asked for two invalid builds and
      // never presented its valid one). Otherwise present what passed and say
      // what didn't (Lightning lost a valid build to an invalid one in the
      // same call, r12 video-editing).
      if (presented.length === 0) {
        const ready = presentableLabels(turnStore);
        const failure = refused[0].failure;
        return ready.length > 0
          ? { ...failure, error: `${failure.error} Ready to present now: ${ready.join(", ")}.`, presentable_labels: ready }
          : failure;
      }
      const renamed = presented.filter((build) => build.validated_label !== undefined);
      return {
        presented: true,
        buildCount: presented.length,
        builds: presented,
        ...(refused.length > 0
          ? { not_presented: refused.map(({ label, failure }) => ({ label, error: failure.error })) }
          : {}),
        ...(renamed.length > 0
          ? { label_note: `Shown under an honest label because it is over the budget: ${renamed.map((b) => `'${b.validated_label}' as '${b.label}'`).join(", ")}. Use that label in your reply.` }
          : {})
      };
    },
    toModelOutput: async ({ output }) => ({ type: "json", value: toModelPresentOutput(output) }) as never
  });
}
