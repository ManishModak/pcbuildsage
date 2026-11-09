import { tool } from "ai";
import { z } from "zod";
import { resolveComponent, withTitleGpuLength, type ComponentCategory } from "../registry";
import { parseSpecsFromTitle } from "../spec-parsers";
import { getCatalogRepository, type CatalogRepository, type CatalogScope, type SearchProductItem } from "../catalog";
import { validateBuild, type BuildIssue, type BuildParts, type BuildPart, type ValidationResult } from "../rules-engine";
import { createBuildSnapshot, type BuildSnapshot } from "../catalog/build-snapshot";
import { createTurnValidationStore, recordValidation, type TurnValidationStore } from "./turn-state";
import { formatPrice, leadingJsonValue, lenientToolSchema, parsedJson } from "./lenient-input";
import { distinguishingPrefix, MIN_PREFIX_LEN, resolveIdPrefix, shortId } from "./product-ids";
import { unnamedOwnedNote, unnamedOwnedParts } from "./owned-parts";


// The field guidance lives once on `parts`, not on each of its nine slots: a
// per-slot copy made this the largest tool schema small models are sent.
// The slot names the category, so a part carries none of its own.
const partSchema = z.union([
  z.string(),
  z.object({
    product_id: z.string().min(1).optional(),
    name: z.string().optional(),
    owned: z.boolean().optional(),
    key: z.string().optional()
  }).refine((part) => Boolean(part.product_id?.trim() || part.key?.trim() || part.name?.trim()), { message: "Part object must include at least one of product_id, key or name." })
]);

export const singleBuildValidationSchema = z.object({
  label: z
    .string()
    .min(1)
    .describe(
      "Short label naming the tradeoff this build makes, e.g. 'Within budget', 'Small upgrade', 'Max Performance'."
    ),
  parts: z
    .object({
      cpu: partSchema.optional(),
      gpu: partSchema.optional(),
      motherboard: partSchema.optional(),
      ram: partSchema.optional(),
      storage: z.union([partSchema, z.array(partSchema)]).optional(),
      psu: partSchema.optional(),
      case: partSchema.optional(),
      cooler: partSchema.optional()
    })
    // Unknown keys fail the call instead of silently dropping a part (see normalizeParts).
    .strict()
    .describe(
      "Every part of this build, keyed by category; storage may be a list. A part to buy is {\"product_id\": the 10-character ID from search_products}. A part the user already owns is {\"name\": \"RTX 3070\", \"owned\": true}: checked for compatibility, costs 0. The tool keeps no state between calls: pass the full build each time."
    )
});

export const validateBuildInputSchema = z.object({
  builds: parsedJson(z
    .array(singleBuildValidationSchema)
    .min(1)
    .max(5)
    // Results are keyed by label, so duplicate labels would silently overwrite each other.
    .refine((builds) => new Set(builds.map((b) => b.label.trim().toLowerCase())).size === builds.length, {
      message: "Each build needs a unique label."
    })
    .describe("One to five complete build proposals to validate side by side, each with a unique label.")),
  budget: z
    .number()
    .positive()
    .optional()
    .describe(
      "The user's whole-build budget in the active currency's standard major units (e.g. 45000). When given, each build gets code-computed budget figures (over_by/under_by) to quote instead of calculating them."
    )
});

export type ValidateBuildInput = z.infer<typeof validateBuildInputSchema>;

/**
 * The provider schema with each build's `parts` as a free-form object, its
 * categories named in the description. Under tool_choice "required" or a named
 * tool, NIM (and llama.cpp) generate arguments from a grammar that fixes the
 * key order to the schema's (cpu before gpu), so Lightning, writing the GPU
 * first as the system prompt's cascade orders it, could not add the CPU after
 * it: every r35 gaming failure. Validation still checks every part.
 */
export function freeOrderParts(jsonSchema: Record<string, unknown>): Record<string, unknown> {
  type Parts = { type?: string; description?: string; properties?: Record<string, unknown>; additionalProperties?: unknown };
  const out = structuredClone(jsonSchema) as { properties?: { builds?: { items?: { properties?: { parts?: Parts } } } } };
  const props = out.properties?.builds?.items?.properties;
  const storage = props?.parts?.properties?.storage;
  if (!props?.parts || !storage) return jsonSchema;
  // Storage's schema (a part or a list of parts) covers every slot's value. A
  // bare {"type":"object"} made NIM's grammar emit an empty object.
  props.parts = {
    type: "object",
    additionalProperties: storage,
    description: `${props.parts.description ?? ""} Keys, in any order: cpu, gpu, motherboard, ram, storage (one part or a list), psu, case, cooler.`.trim()
  };
  return out as Record<string, unknown>;
}

/** Budget figures for one build; over_by and under_by are non-negative and at most one is non-zero. */
export interface BuildBudgetFigures {
  target: number;
  total: number;
  over_by: number;
  under_by: number;
}

/** How much more a build costs than the cheapest build in the same call (0 for the cheapest). */
export interface VsCheapest {
  cheapest_label: string;
  more_by: number;
}

type PricedResult = { snapshot: BuildSnapshot; budget?: BuildBudgetFigures; vs_cheapest?: VsCheapest; price_summary?: string };

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Share of the budget past which an over-budget build gets a note to cut it down (the prompt allows ~2–3% for a clear value jump). */
export const FAR_OVER_BUDGET = 0.05;

/**
 * Adds code-computed price figures to each build result, in place, so the
 * model quotes them instead of doing arithmetic in prose: `budget` when a
 * budget was given, `vs_cheapest` when 2+ builds have totals, and a one-line
 * `price_summary`. Builds without a snapshot total are left unchanged.
 */
export function addPriceFigures(results: Record<string, PricedResult>, budget?: number): void {
  const priced = Object.entries(results).filter(([, r]) => typeof r.snapshot?.total === "number");
  const cheapest = priced.length >= 2
    ? priced.reduce((min, entry) => ((entry[1].snapshot.total as number) < (min[1].snapshot.total as number) ? entry : min))
    : undefined;

  for (const [label, result] of priced) {
    const total = result.snapshot.total as number;
    const currency = result.snapshot.currency;
    const parts = [`Total ${formatPrice(total, currency)}`];
    if (budget !== undefined) {
      const diff = round2(total - budget);
      result.budget = { target: budget, total, over_by: Math.max(0, diff), under_by: Math.max(0, -diff) };
      parts.push(
        diff > 0
          ? `${formatPrice(diff, currency)} over the ${formatPrice(budget, currency)} budget`
          : diff < 0
            ? `${formatPrice(-diff, currency)} under the ${formatPrice(budget, currency)} budget`
            : `exactly the ${formatPrice(budget, currency)} budget`
      );
      // Lightning presented a build ₹177 over budget labelled "Within budget" (r9 esports).
      if (diff > 0 && /within budget/i.test(label)) {
        parts.push(`labelled '${label}' but over budget: swap a part to bring it under, or relabel it and add a build within the budget`);
      } else if (diff > budget * FAR_OVER_BUDGET) {
        // Lightning presented builds 47% and 61% over a ₹1,00,000 budget, saying so in its text (r17 all-amd).
        parts.push(`${Math.round((diff / budget) * 100)}% over: the budget is the user's limit, so swap the priciest parts for cheaper search_products picks and validate again; present a build this far over only beside one within the budget`);
      }
    }
    if (cheapest) {
      const moreBy = round2(total - (cheapest[1].snapshot.total as number));
      result.vs_cheapest = { cheapest_label: cheapest[0], more_by: moreBy };
      if (label !== cheapest[0]) parts.push(`${formatPrice(moreBy, currency)} more than '${cheapest[0]}'`);
    }
    if (parts.length > 1) result.price_summary = parts.join("; ");
  }
}

/**
 * Model numbers a build label names ("3050" in "RTX 3050 Esports", "7600x")
 * that no part name in the build contains. Resolutions ("1080p") and budget
 * figures ("60k", "45000") aren't parts, so they're skipped.
 */
/**
 * A note when a label names a model no part in the build is, e.g. "RTX 3050
 * Esports" with no GPU passed: Lightning validated and presented such builds
 * (r11 no-rgb "GTX 1650", r24 esports "RTX 3050").
 */
function labelNote(label: string, snapshot: BuildSnapshot): { label_note?: string } {
  const missing = labelModelsMissing(label, snapshot.components.map((c) => String(c.name ?? "")));
  return missing.length > 0
    ? { label_note: `The label names ${missing.join(", ")}, but no part in this build does. Add that part (pass every part each call) or rename the build.` }
    : {};
}

const GAMING_REQUEST = /\b(gaming|games?|esports|fps|valorant|cs2|gta|aaa)\b/i;
const NO_GPU_REQUEST = /\b(no|without|don'?t (?:need|want|include))\s+(?:a\s+|any\s+)?(?:dedicated\s+|separate\s+)?(?:gpu|graphics)/i;

/** True when the user's words ask for gaming and don't rule out a graphics card. */
export function wantsGamingGpu(userText: string): boolean {
  return GAMING_REQUEST.test(userText) && !NO_GPU_REQUEST.test(userText);
}

/**
 * A note when the user asked for gaming and a whole build has no graphics
 * card: Lightning dropped the GPU for a 5600G's integrated graphics (r27 and
 * r34 esports) although a GPU build fit the budget, and the system prompt's
 * rule alone didn't hold late in the turn.
 */
function gamingGpuNote(userText: string | undefined, snapshot: BuildSnapshot): { gpu_note?: string } {
  if (userText === undefined || !wantsGamingGpu(userText)) return {};
  const categories = new Set(snapshot.components.map((c) => c.category));
  if (!categories.has("cpu") || categories.has("gpu")) return {};
  return {
    gpu_note:
      "The user asked for a gaming PC and this build has no graphics card. Give a gaming build a dedicated GPU as its largest part, with cheaper parts around it; leave it out only if no GPU fits the budget, and say so."
  };
}

export function labelModelsMissing(label: string, partNames: readonly string[]): string[] {
  const names = partNames.join(" ").toLowerCase();
  return label
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => /\d{3,}/.test(t) && !/^\d+p$/.test(t) && !/^\d+k$/.test(t) && !/^0+$/.test(t) && !(/^\d+$/.test(t) && Number(t) >= 10000))
    .filter((t) => !names.includes(t));
}

/**
 * Core categories a complete desktop build needs. GPU and cooler are left out:
 * an iGPU or a boxed stock cooler can cover them.
 */
const CORE_PARTS = ["cpu", "motherboard", "ram", "storage", "psu", "case"] as const;

/** Core categories absent from a build's parts, reported so a partial build isn't mistaken for a full one. */
export function missingCoreParts(parts: BuildParts | undefined): string[] {
  return CORE_PARTS.filter((category) => !parts?.[category]);
}

/** Prefix lookup against the catalog for short IDs the model passes back. */
async function findIdsByPrefix(
  prefix: string,
  scope: CatalogScope,
  repo: CatalogRepository
): Promise<string[]> {
  const p = prefix.trim();
  if (p.length < MIN_PREFIX_LEN) return [];
  // Escaped: `_` and `%` in a model-supplied prefix are literals, not wildcards.
  const like = `${p.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const countryCode = scope.countryCode ?? "US";
  const currency = scope.currency ?? "USD";
  try {
    const anyRepo = repo as unknown as {
      getDatabase?: (s?: CatalogScope) => {
        prepare: (sql: string) => { all: (...args: unknown[]) => Array<{ id: unknown }> };
      };
      driver?: {
        all: (sql: string, params: unknown[], scope?: CatalogScope) => Promise<unknown[]>;
      };
    };
    if (typeof anyRepo.getDatabase === "function") {
      const db = anyRepo.getDatabase(scope);
      const rows = db
        .prepare("SELECT id FROM products WHERE id LIKE ? ESCAPE '\\' AND country_code = ? AND currency = ? LIMIT 10")
        .all(like, countryCode, currency);
      return rows.map((r) => String(r.id));
    }
    if (anyRepo.driver && typeof anyRepo.driver.all === "function") {
      const rows = await anyRepo.driver.all(
        "SELECT id FROM products WHERE id LIKE ? ESCAPE '\\' AND country_code = ? AND currency = ? LIMIT 10",
        [like, countryCode, currency],
        scope
      );
      return (rows as Array<Record<string, unknown>>).map((r) => String(r.id));
    }
  } catch {
    return [];
  }
  return [];
}

/**
 * An ambiguous ID prefix names no single product, so the build is not valid:
 * the rules engine records any unresolved part as "unverified", which would
 * still let the build pass (and be presented) with a part nobody chose. Turns
 * those checks into failures and their issues into blocking ones, in place.
 */
function failAmbiguousParts(
  validation: ValidationResult,
  parts: BuildParts,
  messageFor: (pid: string, category: ComponentCategory) => string | undefined
): void {
  const messages = new Set<string>();
  for (const [category, raw] of Object.entries(parts) as [ComponentCategory, BuildPart | BuildPart[]][]) {
    for (const part of Array.isArray(raw) ? raw : raw ? [raw] : []) {
      const pid = typeof part === "string" ? part.trim() : part?.product_id?.trim();
      const message = pid ? messageFor(pid, category) : undefined;
      if (message) messages.add(message);
    }
  }
  if (messages.size === 0) return;
  let moved = 0;
  for (const check of validation.checks ?? []) {
    if (check.status === "unverified" && check.message && messages.has(check.message)) {
      check.status = "failed";
      moved++;
    }
  }
  validation.issues = validation.issues.map((issue) =>
    issue.detail && messages.has(issue.detail) ? { ...issue, severity: "blocking" } : issue
  );
  const { passed, failed, unverified } = validation.summary;
  const nowFailed = failed + moved;
  const nowUnverified = Math.max(0, unverified - moved);
  validation.summary = {
    passed,
    failed: nowFailed,
    unverified: nowUnverified,
    text: `${nowFailed} check(s) failed · ${passed} passed · ${nowUnverified} unverified`
  };
  validation.valid = false;
}

/** Records one failed, blocking check on a validation, keeping its summary in step. */
function failCheck(validation: ValidationResult, rule: BuildIssue["rule"], detail: string): void {
  validation.issues = [...validation.issues, { severity: "blocking", rule, components: [], detail }];
  validation.checks = [...(validation.checks ?? []), { rule, status: "failed", components: [], message: detail }];
  const { passed, failed, unverified } = validation.summary;
  validation.summary = { passed, failed: failed + 1, unverified, text: `${failed + 1} check(s) failed · ${passed} passed · ${unverified} unverified` };
  validation.valid = false;
}

/** Spec fields that are provenance or lookup aids, not facts the model reasons with. */
const MODEL_SPEC_NOISE = new Set(["aliases", "sources", "researched_at", "confidence", "brand", "model", "spec_conflict"]);

/** Build fields the model view rebuilds (snapshot, notes, issues) or drops (checks repeat issues; resolved becomes per-part specs). */
const MODEL_VALIDATE_DROPPED = new Set(["checks", "resolved", "snapshot", "not_purchasable_note", "missing_parts_note", "owned_note", "gpu_note", "unnamed_owned", "issues"]);

function shortIdIfLong(id: unknown): unknown {
  return typeof id === "string" && id.length > 10 ? shortId(id) : id;
}

/** A resolved part's specs as the model sees them: scalar facts only. */
function modelSpecs(resolved: unknown): Record<string, unknown> | undefined {
  const spec = (resolved as { spec?: unknown } | null)?.spec;
  if (!spec || typeof spec !== "object") return undefined;
  const kept = Object.entries(spec).filter(([key, value]) => !MODEL_SPEC_NOISE.has(key) && value !== null && typeof value !== "object");
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/**
 * Model-only view: only {builds}, each led by what to fix (not_purchasable_note,
 * missing_parts_note) and trimmed to what the model acts on. A whole build's
 * full output ran ~5K characters (specs with aliases and sources, every check
 * twice as issues and checks, retailer URLs), and Lightning missed the fix
 * note inside it (r12 office). Product IDs are shortened to 10 chars; each
 * snapshot component keeps name, price and its resolved specs. The full
 * output still goes to the UI and the turn store. Also runs on replayed
 * history: an output with no `builds` (an older saved single-build shape)
 * passes through unchanged rather than being emptied.
 */
export function toModelValidateOutput(output: unknown): unknown {
  if (!output || typeof output !== "object") return output;
  const obj = output as Record<string, unknown>;
  const builds = obj.builds;
  if (!builds || typeof builds !== "object") return output;
  const shortBuilds: Record<string, unknown> = {};
  for (const [label, entry] of Object.entries(builds as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") {
      shortBuilds[label] = entry;
      continue;
    }
    const e = entry as Record<string, unknown>;
    const snap = e.snapshot as Record<string, unknown> | undefined;
    if (!snap || !Array.isArray(snap.components)) {
      shortBuilds[label] = e;
      continue;
    }
    const { resolved, not_purchasable_note, missing_parts_note, owned_note, gpu_note, issues } = e;
    const rest = Object.fromEntries(Object.entries(e).filter(([key]) => !MODEL_VALIDATE_DROPPED.has(key)));
    const resolvedByCategory = (resolved && typeof resolved === "object" ? resolved : {}) as Record<string, unknown>;
    shortBuilds[label] = {
      ...(owned_note !== undefined ? { owned_note } : {}),
      ...(gpu_note !== undefined ? { gpu_note } : {}),
      ...(not_purchasable_note !== undefined ? { not_purchasable_note } : {}),
      ...(missing_parts_note !== undefined ? { missing_parts_note } : {}),
      ...rest,
      ...(Array.isArray(issues)
        ? { issues: issues.map((issue) => {
            const { components, ...fields } = (issue ?? {}) as Record<string, unknown>;
            return Array.isArray(components) ? { ...fields, components: components.map(shortIdIfLong) } : fields;
          }) }
        : {}),
      snapshot: {
        total: snap.total,
        ...(snap.total == null && snap.subtotal != null ? { subtotal: snap.subtotal, missing_prices: snap.missing_prices } : {}),
        components: (snap.components as Array<Record<string, unknown>>).map((c) => {
          const specs = typeof c.category === "string" ? modelSpecs(resolvedByCategory[c.category]) : undefined;
          return {
            category: c.category,
            product_id: shortIdIfLong(c.product_id),
            name: c.name,
            price: c.price,
            ...(c.included ? { included: true } : {}),
            ...(c.owned ? { owned: true } : {}),
            ...(specs ? { specs } : {})
          };
        })
      }
    };
  }
  return { builds: shortBuilds };
}

/** True for a part entry that names nothing: null, "", or an object without product_id, key or name. */
function isEmptyPart(part: unknown): boolean {
  if (part === null || part === undefined) return true;
  if (typeof part === "string") return part.trim() === "";
  if (Array.isArray(part)) return part.every(isEmptyPart);
  if (typeof part !== "object") return false;
  const p = part as { product_id?: unknown; key?: unknown; name?: unknown };
  return ![p.product_id, p.key, p.name].some((v) => typeof v === "string" && v.trim() !== "");
}

/**
 * True for a GPU entry that stands for the CPU's own graphics rather than a
 * card: no product_id and a name like "Integrated Radeon Graphics (no discrete
 * GPU)". Lightning sent one marked owned for a 5600G build (r11 hinglish).
 */
function isIntegratedGraphicsPlaceholder(part: unknown): boolean {
  const entry = part as { product_id?: unknown; name?: unknown } | null;
  const name = typeof part === "string" ? part : entry?.product_id ? undefined : entry?.name;
  return typeof name === "string" && /\b(integrated|onboard|on-board|igpu)\b|\bno (discrete|dedicated)\b/i.test(name);
}

/**
 * True for a cooler entry that stands for the CPU's boxed cooler rather than a
 * listing: no product_id, not owned, and a name like "Wraith Stealth (included
 * with Ryzen 5 5600G)". Lightning passed these as parts to buy (r12 local-ai,
 * aaa), which made the build unpresentable.
 */
function isStockCoolerPlaceholder(part: unknown): boolean {
  const entry = part as { product_id?: unknown; name?: unknown; owned?: unknown } | null;
  const name = typeof part === "string" ? part : entry?.product_id || entry?.owned === true ? undefined : entry?.name;
  return typeof name === "string" && /\b(stock|included|bundled|in[- ]box|boxed|wraith)\b/i.test(name);
}

/** Part keys models use for a category, after lowercasing and turning spaces and hyphens into underscores. */
const PART_KEY_ALIASES: Record<string, string> = {
  processor: "cpu",
  graphics: "gpu", graphics_card: "gpu", video_card: "gpu",
  mainboard: "motherboard", mobo: "motherboard", board: "motherboard",
  memory: "ram",
  ssd: "storage", hdd: "storage", drive: "storage",
  power_supply: "psu",
  cabinet: "case", chassis: "case",
  cpu_cooler: "cooler"
};

/** The category a part key names: the key itself, normalized, or the category it is an alias of. */
function partCategory(key: string): string {
  const normalized = key.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return PART_KEY_ALIASES[normalized] ?? normalized;
}

/**
 * Cleans each build's parts before validation. Keys are mapped to their
 * category ("Processor" -> cpu, "mainboard" -> motherboard): providers are sent
 * parts with free key names (see freeOrderParts), and the schema rejects any
 * key left unknown rather than dropping that part. A key whose category is
 * already taken stays as written, so it is rejected too. Drops entries that
 * name nothing (Lightning sent `"cooler":{}` for "no cooler"), GPU entries
 * standing for integrated graphics and cooler entries standing for a boxed
 * cooler, so they read as an absent part instead of failing the whole call,
 * counting as an owned card or blocking presentation.
 */
export function normalizeParts(input: Record<string, unknown>): Record<string, unknown> {
  const builds = typeof input.builds === "string" ? (() => { try { return JSON.parse(input.builds as string) as unknown; } catch { return leadingJsonValue(input.builds as string) ?? input.builds; } })() : input.builds;
  if (!Array.isArray(builds)) return input;
  return {
    ...input,
    builds: builds.map((build) => {
      const parts = (build as { parts?: unknown } | null)?.parts;
      if (!parts || typeof parts !== "object" || Array.isArray(parts)) return build;
      // Keys already naming their category first, so an alias never displaces one.
      const entries = Object.entries(parts).sort(([a], [b]) => Number(a !== partCategory(a)) - Number(b !== partCategory(b)));
      const keyed: Record<string, unknown> = {};
      for (const [key, part] of entries) {
        const category = partCategory(key);
        keyed[category in keyed ? key : category] = part;
      }
      return { ...(build as object), parts: Object.fromEntries(Object.entries(keyed).filter(([category, part]) => !isEmptyPart(part) && !(category === "gpu" && isIntegratedGraphicsPlaceholder(part)) && !(category === "cooler" && isStockCoolerPlaceholder(part)))) };
    })
  };
}

/** Ends a rejected validate_build call's error, so the model can fix the call instead of dropping `builds`. */
export const VALIDATE_BUILD_INPUT_HINT =
  'Pass builds as a JSON array (not a string) of 1 to 5 objects, each with a unique label and parts holding every part of that build. Example: {"budget":45000,"builds":[{"label":"Within budget","parts":{"cpu":{"product_id":"da6670a41d"},"motherboard":{"product_id":"3a1ade8a84"},"ram":{"product_id":"245608e19e"},"storage":{"product_id":"d5ac436749"},"psu":{"product_id":"cfcdeeb795"},"case":{"product_id":"c2e05370d9"}}}]}';

/** A part a presented build couldn't be bought with: not owned, not an included cooler, not an in-stock listing. */
export interface UnpurchasablePart {
  category: string;
  name: string;
  reason: "unknown product ID" | "not a catalog product" | "out of stock" | "listed under another category";
  /** In-stock catalog listings whose names match this part, to swap in. */
  in_stock_matches?: PartMatch[];
}

/** An in-stock listing offered in place of an unpurchasable part. */
export interface PartMatch {
  product_id: string;
  name: string;
  price: number | null;
}

/**
 * Search terms for finding a named part in the catalog: the name itself, then
 * its longest token with a digit ("10100" from "intel-core-i3-10100"), since
 * catalog search is a substring match and models write names in many shapes.
 */
export function partMatchTerms(name: string): string[] {
  const modelToken = name
    .split(/[\s\-_/(),]+/)
    .filter((token) => /\d/.test(token) && token.length >= 3)
    .sort((a, b) => b.length - a.length)[0];
  return [...new Set([name.trim(), modelToken].filter((term): term is string => Boolean(term)))];
}

/**
 * Parts of a snapshot that keep it from being presented as a build to buy.
 * A part in a category with no in-stock catalog listings at all is left
 * alone: there the prompt asks for a derived requirement ("Any 650 W PSU").
 */
export async function unpurchasableParts(
  snapshot: BuildSnapshot,
  byId: Map<string, { category: string; in_stock?: boolean }>,
  stockedCategory: (category: string) => Promise<boolean>,
  findMatches?: (category: string, name: string) => Promise<PartMatch[]>
): Promise<UnpurchasablePart[]> {
  const found: UnpurchasablePart[] = [];
  for (const component of snapshot.components) {
    if (component.included || component.owned) continue;
    const category = String(component.category);
    const product = component.product_id ? byId.get(component.product_id) : undefined;
    const reason: UnpurchasablePart["reason"] | undefined = !product
      ? component.product_id ? "unknown product ID" : "not a catalog product"
      : product.category !== category ? "listed under another category"
        : product.in_stock === false ? "out of stock" : undefined;
    if (!reason || !(await stockedCategory(category))) continue;
    const matches = findMatches ? await findMatches(category, component.name) : [];
    found.push({ category, name: component.name, reason, ...(matches.length ? { in_stock_matches: matches } : {}) });
  }
  return found;
}

/** Tells the model how to make a build presentable again. */
export function notPurchasableNote(parts: UnpurchasablePart[]): string {
  const listed = parts
    .map((p) => {
      const matches = p.in_stock_matches?.map((m) => `${m.product_id} ${m.name}${m.price === null ? "" : ` at ${m.price}`}`).join("; ");
      return `${p.category} "${p.name}" (${p.reason}${matches ? `; in stock: ${matches}` : ""})`;
    })
    .join(", ");
  return `This build can't be presented until every part is an in-stock catalog listing: ${listed}. Replace each with a product_id from search_products for that category. For a part the user already owns, pass {"name":"...","owned":true}; when the CPU includes a stock cooler, leave the cooler out.`;
}

/**
 * Builds the validate_build tool. `requireCatalogParts` (chat) adds
 * not_purchasable to builds a user couldn't buy as shown; such builds still
 * validate (spot checks with named parts stay useful) but can't be presented.
 * `userText` (chat: the user's messages) adds unnamed_owned for owned parts
 * the user never named, which likewise can't be presented.
 */
export function createValidateBuildTool(
  scope: CatalogScope = { countryCode: "US", currency: "USD" },
  repository?: CatalogRepository,
  store?: TurnValidationStore,
  options?: { requireCatalogParts?: boolean; userText?: string }
) {
  const turnStore = store ?? createTurnValidationStore();
  // Per tool instance (one chat turn): whether a category has any in-stock listing.
  const stockedCache = new Map<string, Promise<boolean>>();
  const stockedCategory = (category: string): Promise<boolean> => {
    let known = stockedCache.get(category);
    if (!known) {
      const repo = repository ?? getCatalogRepository();
      known = repo
        .searchProducts({ category, in_stock: true, inStockOnly: true, limit: 1 }, scope)
        .then((r) => r.results.length > 0)
        .catch(() => false);
      stockedCache.set(category, known);
    }
    return known;
  };
  // Up to 3 in-stock listings per term in partMatchTerms, first term that finds any.
  const findMatches = async (category: string, name: string): Promise<PartMatch[]> => {
    const repo = repository ?? getCatalogRepository();
    for (const term of partMatchTerms(name)) {
      const found = await repo
        .searchProducts({ term, category, in_stock: true, inStockOnly: true, limit: 3 }, scope)
        .catch(() => ({ results: [] as SearchProductItem[] }));
      if (found.results.length) {
        return found.results.map((p) => ({ product_id: p.id.slice(0, 10), name: p.name, price: typeof p.price === "number" ? p.price : null }));
      }
    }
    return [];
  };
  return tool({
    description:
      "Use validate_build to validate 1 to 5 proposed PC builds side by side in a single call before presenting them. Each build must have a short label naming its tradeoff (e.g. 'Within budget', 'Small upgrade', 'Max Performance') and its component parts. Returns compatibility results and authoritative code-calculated build snapshots with catalog prices, product IDs, and totals keyed by label. Pass the user's budget to get code-computed budget.over_by/under_by per build, and vs_cheapest when comparing 2+ builds; quote these figures and each price_summary rather than calculating differences yourself. Preferred parts format uses catalog product ID prefixes from search_products (first 10 chars, min 8): {\"budget\":45000,\"builds\":[{\"label\":\"Within budget\",\"parts\":{\"cpu\":{\"product_id\":\"da6670a41d\"},\"gpu\":{\"product_id\":\"a1f8c14e1a\"}}}]}.",
    inputSchema: lenientToolSchema(validateBuildInputSchema, "validate_build", VALIDATE_BUILD_INPUT_HINT, normalizeParts, freeOrderParts),
    toModelOutput: async ({ output }) => ({ type: "json", value: toModelValidateOutput(output) }) as never,
    execute: async (rawInput: unknown) => {
      const input = (rawInput ?? {}) as {
        builds?: Array<{ label: string; parts: BuildParts }>;
        budget?: number;
        label?: string;
        parts?: BuildParts;
      };

      const buildList: Array<{ label: string; parts: BuildParts }> =
        Array.isArray(input.builds) && input.builds.length > 0
          ? input.builds
          : [{ label: input.label ?? "Proposed Build", parts: input.parts ?? {} }];

      // Collect candidate product IDs across all builds in the batch
      const candidateIds = Array.from(
        new Set(
          buildList.flatMap((b) =>
            Object.values(b.parts)
              .flatMap((raw) => (Array.isArray(raw) ? raw : [raw]))
              .flatMap((part) => {
                if (!part) return [];
                if (typeof part === "string" && part.trim().length > 0) return [part.trim()];
                if (typeof part === "object" && part && part.product_id?.trim()) return [part.product_id.trim()];
                return [];
              })
          )
        )
      );

      const repo = repository ?? getCatalogRepository();
      const products = candidateIds.length > 0
        ? await repo.searchProducts({ product_ids: candidateIds, inStockOnly: false, limit: candidateIds.length }, scope)
        : { results: [], total_matching: 0 };
      const byId = new Map(products.results.map((product) => [product.id, product]));

      // Resolve unique prefixes (>=8 chars) to full catalog IDs. Exact IDs
      // win; otherwise a single LIKE match wins and ambiguous prefixes are
      // reported as unresolved with candidates.
      const prefixToFull = new Map<string, string>();
      const prefixAmbiguous = new Map<string, string[]>();
      for (const candidate of candidateIds) {
        if (byId.has(candidate)) continue;
        if (candidate.length < MIN_PREFIX_LEN) continue;
        const matches = await findIdsByPrefix(candidate, scope, repo);
        if (matches.length === 1 && !byId.has(matches[0])) {
          const fullProducts = await repo.searchProducts(
            { product_ids: [matches[0]], inStockOnly: false, limit: 1 },
            scope
          );
          for (const p of fullProducts.results) byId.set(p.id, p);
        }
        if (matches.length === 1) {
          prefixToFull.set(candidate, matches[0]);
        } else if (matches.length > 1) {
          prefixAmbiguous.set(candidate, matches);
        }
      }

      // Names for ambiguous candidates, so the error can tell the model which
      // product each distinguishing prefix is.
      const ambiguousIds = [...new Set([...prefixAmbiguous.values()].flat())];
      const ambiguousNames = new Map<string, string>();
      if (ambiguousIds.length > 0) {
        const found = await repo.searchProducts(
          { product_ids: ambiguousIds, inStockOnly: false, limit: ambiguousIds.length },
          scope
        );
        for (const p of found.results) ambiguousNames.set(p.id, p.name);
      }
      const ambiguityMessage = (pid: string, category: ComponentCategory): string | undefined => {
        const matches = prefixAmbiguous.get(pid);
        if (!matches) return undefined;
        const listed = matches
          .map((id) => {
            const name = ambiguousNames.get(id);
            return name ? `${distinguishingPrefix(id, matches)} (${name})` : distinguishingPrefix(id, matches);
          })
          .join(", ");
        return `Ambiguous product ID prefix '${pid}' for ${category} matches ${matches.length} products: ${listed}. Pass one of these prefixes.`;
      };

      const resolveSuppliedId = (raw: string): string => {
        const trimmed = raw.trim();
        if (byId.has(trimmed)) return trimmed;
        const mapped = prefixToFull.get(trimmed);
        if (mapped) return mapped;
        // An ambiguous prefix stays unresolved: another build in the batch
        // loading one of its matches must not make it silently pick that one.
        if (prefixAmbiguous.has(trimmed)) return trimmed;
        // Fall back to in-memory prefix match against already-loaded IDs
        // (covers mock repos without LIKE support).
        const loaded = [...byId.keys()];
        const res = resolveIdPrefix(trimmed, loaded);
        if ("full" in res) return res.full;
        return trimmed;
      };

      const results: Record<string, ValidationResult & PricedResult> = {};

      for (const b of buildList) {
        // Narrow server-side normalization:
        // Exact catalog IDs win; unique prefixes resolve to their full ID and
        // are stored as full IDs. Registry-key/name support is preserved when
        // there is no catalog ID match.
        const normalizePart = (part: BuildPart): BuildPart => {
          if (typeof part === "string") {
            const trimmed = part.trim();
            if (byId.has(trimmed) || prefixToFull.has(trimmed)) {
              return { product_id: resolveSuppliedId(trimmed) };
            }
            // A hash-like string that resolves as a unique prefix against
            // loaded IDs is a product reference, not a registry key.
            if (trimmed.length >= MIN_PREFIX_LEN && !prefixAmbiguous.has(trimmed)) {
              const res = resolveIdPrefix(trimmed, [...byId.keys()]);
              if ("full" in res) return { product_id: res.full };
            }
            return part;
          }
          if (part && typeof part.product_id === "string") {
            const pid = part.product_id.trim();
            const full = resolveSuppliedId(pid);
            if (full !== part.product_id) return { ...part, product_id: full };
            if (pid !== part.product_id) return { ...part, product_id: pid };
          }
          return part;
        };

        const normalizedParts: BuildParts = {};
        // Listings passed in another category's slot (Lightning put its CPU
        // under "cooler", r12 aaa) move to their own slot when it is empty.
        const moved: string[] = [];
        for (const [category, raw] of Object.entries(b.parts) as [ComponentCategory, BuildPart | BuildPart[]][]) {
          if (!raw) continue;
          if (Array.isArray(raw)) {
            normalizedParts[category] = raw.map(normalizePart);
            continue;
          }
          const part = normalizePart(raw);
          const pid = typeof part === "object" && part?.product_id ? part.product_id : undefined;
          const home = pid ? (byId.get(pid)?.category as ComponentCategory | undefined) : undefined;
          if (pid && home && home !== category && !b.parts[home] && !normalizedParts[home]) {
            normalizedParts[home] = part;
            moved.push(`${shortId(pid)} from ${category} to ${home}`);
          } else {
            normalizedParts[category] = part;
          }
        }

        const getUnresolvedMessage = (part: BuildPart, category: ComponentCategory): string => {
          const ambiguous = ambiguityMessage(typeof part === "string" ? part.trim() : (part?.product_id?.trim() ?? ""), category);
          if (ambiguous) return ambiguous;
          if (typeof part === "object" && part && part.product_id) {
            const pid = part.product_id.trim();
            const product = byId.get(pid);
            if (!product) {
              return `Unresolved product ID '${pid}' for ${category}. Verify the product ID from search_products results.`;
            }
            if (product.category !== category) {
              return `Product '${pid}' is categorized as ${product.category}, not ${category}.`;
            }
            return `No ${category} specs found in registry or research cache for '${product.name}'.`;
          }
          if (typeof part === "string") {
            return `Unresolved component ID or name '${part}' for ${category}. Ensure product IDs match search_products results or specify a known component name.`;
          }
          return `No ${category} specs found in registry or research cache.`;
        };

        const validation = validateBuild(normalizedParts, {
          resolve: (part, category) => {
            if (typeof part === "string" || !part.product_id) {
              return resolveComponent(typeof part === "string" ? { key: part, name: part, category } : { ...part, category });
            }
            const product = byId.get(part.product_id.trim());
            if (!product || product.category !== category) return undefined;
            const resolved = resolveComponent({ key: product.registry_key ?? undefined, name: product.name, category });
            if (!resolved) return undefined;
            // One narrow merge path for offer-title specs: GPU lengths go through
            // the provenance/conflict handling in withTitleGpuLength (idempotent
            // when resolveComponent already merged the same title); RAM keeps its
            // title capacity normalization.
            const withTitle = category === "gpu" ? withTitleGpuLength(resolved, product.name) : resolved;
            const titleSpecs = category === "ram" ? parseSpecsFromTitle(product.name, category) : undefined;
            return { ...withTitle, key: product.id, spec: { ...withTitle.spec, ...titleSpecs, ...(product.specs?.spec_conflict ? { spec_conflict: product.specs.spec_conflict } : {}) } };
          },
          getUnresolvedMessage
        });

        failAmbiguousParts(validation, normalizedParts, (pid, category) => ambiguityMessage(pid, category));

        const missing = missingCoreParts(normalizedParts);
        // A build with a board and no CPU is a whole build missing its CPU, not an
        // upgrade pick: a failed check, recorded before the snapshot copies the
        // verdict. (r35's ten such Lightning calls a turn came from the provider
        // grammar dropping a CPU written after the GPU: see freeOrderParts.)
        const boardWithoutCpu = missing.includes("cpu") && !missing.includes("motherboard");
        if (boardWithoutCpu) failCheck(validation, "cpu_support", "No CPU in this build: a build with a motherboard needs its CPU.");
        const snapshot = createBuildSnapshot({ label: b.label, parts: normalizedParts, validation, productsById: byId, scope });
        const unpurchasable = options?.requireCatalogParts ? await unpurchasableParts(snapshot, byId, stockedCategory, findMatches) : [];
        const unnamedOwned = options?.userText !== undefined ? unnamedOwnedParts(snapshot.components, options.userText) : [];
        results[b.label] = {
          ...validation,
          snapshot,
          ...(missing.length
            ? {
                missing_parts: missing,
                missing_parts_note: `${boardWithoutCpu ? 'Invalid: no CPU in parts. Naming a CPU in the label does not add it; put it in parts as "cpu":{"product_id":"..."}. ' : ""}Only the parts passed in this call were validated; the tool keeps no parts between calls. Not included: ${missing.join(", ")}. Pass every part of the build in one call; for a part the user already owns, pass {"name":"...","owned":true}. A whole build missing a part can't be presented.`
              }
            : {}),
          ...(unpurchasable.length ? { not_purchasable: unpurchasable, not_purchasable_note: notPurchasableNote(unpurchasable) } : {}),
          ...(unnamedOwned.length ? { unnamed_owned: unnamedOwned, owned_note: unnamedOwnedNote(unnamedOwned) } : {}),
          ...(moved.length ? { moved_parts_note: `Moved to the slot of their catalog category: ${moved.join("; ")}. Pass them there next time.` } : {}),
          ...labelNote(b.label, snapshot),
          ...gamingGpuNote(options?.userText, snapshot)
        };
        recordValidation(turnStore, b.label, results[b.label]);
      }

      addPriceFigures(results, typeof input.budget === "number" && input.budget > 0 ? input.budget : undefined);

      const isLegacySingle = !(rawInput && typeof rawInput === "object" && "builds" in rawInput) && Boolean((rawInput as { parts?: unknown })?.parts);
      const firstResult = Object.values(results)[0];

      if (isLegacySingle && firstResult) {
        const legacyReturn = Object.assign(firstResult, { builds: results, ...results });
        results[Object.keys(results)[0]] = legacyReturn;
        return legacyReturn;
      }

      return {
        builds: results,
        ...results
      };
    }
  });
}
