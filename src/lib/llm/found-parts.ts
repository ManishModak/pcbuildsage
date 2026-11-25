import type { ToolSet } from "ai";
import { extractSearchResultEntries } from "@/lib/tools/search-products";

type FoundPart = { id: string; name: string; price?: number };

/** Rows of each category's latest search that a reminder lists. */
const PARTS_PER_CATEGORY = 3;

function toFoundParts(results: ReadonlyArray<Record<string, unknown>>): FoundPart[] {
  return results
    .filter((row): row is { id: string; name: string; price?: unknown } =>
      Boolean(row) && typeof row.id === "string" && typeof row.name === "string")
    .slice(0, PARTS_PER_CATEGORY)
    .map((row) => ({ id: row.id.slice(0, 10), name: row.name, ...(typeof row.price === "number" ? { price: row.price } : {}) }));
}

function unwrapOutput(output: unknown): unknown {
  if (!output || typeof output !== "object") return output;
  const obj = output as Record<string, unknown>;
  if ("value" in obj) return obj.value;
  if (Array.isArray(obj.content) && obj.structuredContent && typeof obj.structuredContent === "object") {
    return obj.structuredContent;
  }
  return output;
}

/** Categories a validate_build model output reports as left out of any build. */
function missingCategories(value: unknown): string[] {
  const builds = (unwrapOutput(value) as { builds?: unknown } | null)?.builds;
  if (!builds || typeof builds !== "object") return [];
  const missing = new Set<string>();
  for (const entry of Object.values(builds)) {
    const parts = (entry as { missing_parts?: unknown } | null)?.missing_parts;
    if (Array.isArray(parts)) parts.forEach((p) => typeof p === "string" && missing.add(p));
  }
  return [...missing];
}

type BuildsInput = { builds?: Array<{ label?: unknown; parts?: Record<string, unknown> }> };

/** "product_id" or name of a part entry, else null. */
function partRef(part: unknown): string | null {
  if (typeof part === "string") return part.trim() || null;
  if (Array.isArray(part)) return partRef(part[0]);
  const entry = part as { product_id?: unknown; name?: unknown } | null;
  if (typeof entry?.product_id === "string" && entry.product_id.trim()) return entry.product_id.trim();
  if (typeof entry?.name === "string" && entry.name.trim()) return entry.name.trim();
  return null;
}

/** "label: category (earlier pick), ..." for categories an earlier call had that a build now leaves out. */
function droppedParts(input: unknown, picked: Map<string, string>, names: Map<string, string>): string[] {
  const builds = (input as BuildsInput | null)?.builds;
  if (!Array.isArray(builds) || picked.size === 0) return [];
  return builds.flatMap((build) => {
    const parts = build?.parts ?? {};
    const dropped = [...picked].filter(([category]) => partRef(parts[category]) === null);
    if (dropped.length === 0) return [];
    const list = dropped.map(([category, ref]) => `${category} (${names.has(ref.slice(0, 10)) ? `${ref.slice(0, 10)} ${names.get(ref.slice(0, 10))}` : ref})`);
    return [`"${String(build?.label ?? "")}" leaves out ${list.join(", ")}`];
  });
}

/**
 * Wraps search_products and validate_build for one turn: when a validate call
 * leaves out a core part, its result lists the top rows of that category's
 * latest search, so the model can fill the gap without searching again. Small
 * models (Nemotron Lightning, r11) lost earlier picks and re-searched or
 * validated a GPU, case and cooler alone. A build that leaves out a category
 * an earlier call this turn had also gets a note naming that pick: Ornith
 * (r15, 4K) validated a GPU, case and cooler, then whole builds without the
 * GPU, which the CPU's integrated graphics let pass. Other tools are untouched.
 */
export function rememberFoundParts(tools: ToolSet): ToolSet {
  const search = tools.search_products;
  const validate = tools.validate_build;
  if (!search?.execute || !validate?.toModelOutput) return tools;
  const found = new Map<string, FoundPart[]>();
  // Every part a validate call this turn has passed, by category, and names of searched rows by 10-char ID.
  const picked = new Map<string, string>();
  const names = new Map<string, string>();
  // Freeze per-call reminders at execution time so replaying earlier steps stays byte-identical.
  const remindersByCall = new Map<string, { dropped?: string[]; reminder: Record<string, FoundPart[]> }>();
  const execute = search.execute;
  const validateExecute = validate.execute;
  const toModelOutput = validate.toModelOutput;
  return {
    ...tools,
    search_products: {
      ...search,
      execute: (async (input: unknown, options: unknown) => {
        const output = await (execute as (input: unknown, options: unknown) => unknown)(input, options);
        for (const entry of extractSearchResultEntries(input, output)) {
          const rows = toFoundParts(entry.results);
          for (const row of rows) names.set(row.id, row.name);
          if (entry.category && rows.length > 0) {
            found.set(entry.category, rows);
          } else {
            // Uncategorized search: group rows by their own category if present.
            const byCategory = new Map<string, Array<Record<string, unknown>>>();
            for (const row of entry.results) {
              if (typeof row.category === "string" && row.category.trim()) {
                const cat = row.category.trim().toLowerCase();
                const list = byCategory.get(cat) ?? [];
                list.push(row);
                byCategory.set(cat, list);
              }
            }
            for (const [cat, catRows] of byCategory) {
              const foundRows = toFoundParts(catRows);
              if (foundRows.length > 0) found.set(cat, foundRows);
            }
          }
        }
        return output;
      }) as typeof execute
    } as typeof search,
    validate_build: {
      ...validate,
      ...(validateExecute
        ? {
            execute: (async (input: unknown, options: unknown) => {
              const dropped = droppedParts(input, picked, names);
              const callId = (options as { toolCallId?: unknown } | null)?.toolCallId;
              for (const build of (input as BuildsInput | null)?.builds ?? []) {
                for (const [category, part] of Object.entries(build?.parts ?? {})) {
                  const ref = partRef(part);
                  if (ref) picked.set(category, ref);
                }
              }
              const output = await (validateExecute as (input: unknown, options: unknown) => unknown)(input, options);
              if (typeof callId === "string") {
                const reminder = Object.fromEntries(
                  missingCategories(output).flatMap((c) => (found.has(c) ? [[c, found.get(c)!]] : []))
                );
                remindersByCall.set(callId, {
                  ...(dropped.length > 0 ? { dropped } : {}),
                  reminder
                });
              }
              return output;
            }) as typeof validateExecute
          }
        : {}),
      toModelOutput: (async (args: { toolCallId?: string }) => {
        const base = (await (toModelOutput as (a: unknown) => unknown)(args)) as { type?: string; value?: unknown } | null;
        if (base?.type !== "json" || !base.value || typeof base.value !== "object") return base;
        const frozen = args.toolCallId ? remindersByCall.get(args.toolCallId) : undefined;
        const reminder = frozen
          ? frozen.reminder
          : Object.fromEntries(missingCategories(base.value).flatMap((c) => (found.has(c) ? [[c, found.get(c)!]] : [])));
        const dropped = frozen?.dropped;
        if (Object.keys(reminder).length === 0 && !dropped) return base;
        return {
          ...base,
          value: {
            ...(dropped ? { dropped_parts_note: `${dropped.join("; ")}: an earlier validate_build call this turn had them. The tool keeps nothing between calls, so put each back in its build unless you left it out on purpose, and validate again.` } : {}),
            ...base.value,
            ...(Object.keys(reminder).length > 0
              ? {
                  found_earlier: reminder,
                  found_earlier_note: "Parts your earlier searches found for the categories left out above. Validate again with every part in one call, picking from these (or other results you already have) instead of searching again."
                }
              : {})
          }
        };
      }) as NonNullable<typeof toModelOutput>
    } as typeof validate
  };
}
