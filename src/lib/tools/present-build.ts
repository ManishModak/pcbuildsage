import { tool } from "ai";
import { z } from "zod";
import {
  createTurnValidationStore,
  normalizeLabel,
  validLabels,
  type TurnValidationStore
} from "./turn-state";
import { idsMatch, MIN_PREFIX_LEN, resolveIdPrefix, shortId } from "./product-ids";

export const presentBuildInputSchema = z.object({
  builds: z
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
    .describe("One or more complete build proposals")
});

export type PresentBuildInput = z.infer<typeof presentBuildInputSchema>;

export function createPresentBuildTool(store?: TurnValidationStore) {
  const hasTurnStore = Boolean(store);
  const turnStore = store ?? createTurnValidationStore();
  return tool({
    description:
      "Present one or more complete, finalized PC builds to the user as an interactive visual card with toggle tabs, retailer buy links, and total price calculation. Call this with labels matching validate_build from this turn; product_ids are optional prefixes (first 10 chars, min 8) and default to the validated snapshot. All pricing, retailer links, and totals come authoritatively from the matching validate_build snapshot. Do NOT repeat a markdown table of parts/prices in your text response.",
    inputSchema: presentBuildInputSchema,
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
      const presented: Array<{ label: string; product_ids: string[]; notes?: string }> = [];
      for (const build of input.builds) {
        const entry = turnStore.get(normalizeLabel(build.label));
        if (!entry) {
          const valid = validLabels(turnStore);
          return {
            presented: false,
            error: `No validation this turn for label '${build.label}'. Valid labels: ${valid.length > 0 ? valid.join(", ") : "(none — call validate_build first)"}.`,
            valid_labels: valid
          };
        }
        const issues = Array.isArray(entry.validation.issues) ? entry.validation.issues : [];
        const blocking = issues.filter((i) => i?.severity === "blocking");
        if (entry.validation.valid !== true || blocking.length > 0) {
          return {
            presented: false,
            error: `Build '${build.label}' has blocking compatibility issues and cannot be presented. Resolve them and re-validate.`,
            issues: blocking.map((i) => i.detail ?? i.rule)
          };
        }
        const snapshotIds = entry.productIds;
        const supplied = Array.isArray(build.product_ids) ? build.product_ids : [];
        if (supplied.length === 0) {
          presented.push({
            label: entry.label,
            product_ids: snapshotIds,
            ...(build.notes ? { notes: build.notes } : {})
          });
          continue;
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
              error: `Product IDs for '${build.label}' differ from its validation snapshot. Expected: ${snapshotIds.map(shortId).join(", ")}.`
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
            error: `Product IDs for '${build.label}' differ from its validation snapshot. Expected: ${snapshotIds.map(shortId).join(", ")}.`
          };
        }
        presented.push({
          label: entry.label,
          product_ids: resolved,
          ...(build.notes ? { notes: build.notes } : {})
        });
      }
      return {
        presented: true,
        buildCount: presented.length,
        builds: presented
      };
    }
  });
}
