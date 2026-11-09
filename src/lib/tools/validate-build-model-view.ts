import { memorySupportDdr } from "../catalog/compact";
import { shortId } from "./product-ids";

// validate_build's output as the model sees it: trimmed to what it acts on.
// The full output still goes to the UI and the turn store.

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
  const ddr = memorySupportDdr(spec as Record<string, unknown>);
  const kept = Object.entries(spec).filter(([key, value]) => !MODEL_SPEC_NOISE.has(key) && key !== "ddr" && value !== null && typeof value !== "object");
  if (typeof ddr === "string") kept.push(["ddr", ddr]);
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
