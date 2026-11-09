import type { ToolSet } from "ai";

type FoundPart = { id: string; name: string; price?: number };

/** Rows of each category's latest search that a reminder lists. */
const PARTS_PER_CATEGORY = 3;

function searchRows(output: unknown): FoundPart[] {
  const results = (output as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  return results
    .filter((row): row is { id: string; name: string; price?: unknown } =>
      Boolean(row) && typeof row.id === "string" && typeof row.name === "string")
    .slice(0, PARTS_PER_CATEGORY)
    .map((row) => ({ id: row.id.slice(0, 10), name: row.name, ...(typeof row.price === "number" ? { price: row.price } : {}) }));
}

/** Categories a validate_build model output reports as left out of any build. */
function missingCategories(value: unknown): string[] {
  const builds = (value as { builds?: unknown } | null)?.builds;
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
  const droppedByCall = new Map<string, string[]>();
  const execute = search.execute;
  const validateExecute = validate.execute;
  const toModelOutput = validate.toModelOutput;
  return {
    ...tools,
    search_products: {
      ...search,
      execute: (async (input: unknown, options: unknown) => {
        const output = await (execute as (input: unknown, options: unknown) => unknown)(input, options);
        const category = (input as { category?: unknown } | null)?.category;
        const rows = searchRows(output);
        if (typeof category === "string" && rows.length > 0) found.set(category.trim().toLowerCase(), rows);
        for (const row of searchRows(output)) names.set(row.id, row.name);
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
              if (dropped.length > 0 && typeof callId === "string") droppedByCall.set(callId, dropped);
              for (const build of (input as BuildsInput | null)?.builds ?? []) {
                for (const [category, part] of Object.entries(build?.parts ?? {})) {
                  const ref = partRef(part);
                  if (ref) picked.set(category, ref);
                }
              }
              return (validateExecute as (input: unknown, options: unknown) => unknown)(input, options);
            }) as typeof validateExecute
          }
        : {}),
      toModelOutput: (async (args: { toolCallId?: string }) => {
        const base = (await (toModelOutput as (a: unknown) => unknown)(args)) as { type?: string; value?: unknown } | null;
        if (base?.type !== "json" || !base.value || typeof base.value !== "object") return base;
        const reminder = Object.fromEntries(missingCategories(base.value).flatMap((c) => (found.has(c) ? [[c, found.get(c)!]] : [])));
        const dropped = args.toolCallId ? droppedByCall.get(args.toolCallId) : undefined;
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
