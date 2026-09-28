import { jsonSchema, zodSchema, type Schema } from "ai";
import { z } from "zod";

type ObjectSchema = z.ZodObject<z.ZodRawShape>;

/** Base zod type of a field, looking through optional/default/nullable and pipe inputs. */
function baseType(field: z.ZodType): string {
  let current = field as unknown as { _zod: { def: Record<string, unknown> & { type: string } } };
  for (;;) {
    const def = current._zod.def;
    if (def.type === "optional" || def.type === "default" || def.type === "nullable" || def.type === "prefault") {
      current = def.innerType as typeof current;
    } else if (def.type === "pipe") {
      current = def.in as typeof current;
    } else {
      return def.type;
    }
  }
}

/**
 * Normalizes what small models tend to send before strict validation:
 * numeric strings ("20000") become numbers, "true"/"false" become booleans,
 * and null on an optional field counts as omitted. Anything else is left for
 * the schema to reject, so "", "abc" or "yes" still fail with a clear message.
 */
export function coerceLenientValues(
  schema: ObjectSchema,
  raw: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = schema.shape[key] as z.ZodType | undefined;
    if (!field) {
      out[key] = value;
      continue;
    }
    if (value === null && field.safeParse(undefined).success) continue;
    const type = baseType(field);
    if (typeof value === "string" && type === "number") {
      const trimmed = value.trim();
      const n = Number(trimmed);
      out[key] = trimmed !== "" && Number.isFinite(n) ? n : value;
    } else if (typeof value === "string" && type === "boolean") {
      const lowered = value.trim().toLowerCase();
      out[key] = lowered === "true" ? true : lowered === "false" ? false : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Splits input into known schema fields and the names of unknown ones. */
export function splitUnknownFields<T extends object>(
  input: T,
  validKeys: readonly string[]
): { known: T; ignored: string[] } {
  const known: Record<string, unknown> = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(input ?? {})) {
    if (validKeys.includes(key)) known[key] = value;
    else ignored.push(key);
  }
  return { known: known as T, ignored };
}

/** One-line note for the tool result listing the unknown fields that were dropped. */
export function ignoredFieldsNote(ignored: string[], validKeys: readonly string[]): string {
  return `Ignored unknown field(s): ${ignored.join(", ")}. Valid filters: ${validKeys.join(", ")}.`;
}

/**
 * Tool input schema that sends providers the strict zod JSON schema unchanged
 * (descriptions, types, additionalProperties: false) but validates leniently:
 * values are coerced with coerceLenientValues, and unknown fields are kept on
 * the parsed value so execute() can drop and report them instead of the whole
 * call failing. `toJSONSchema` is kept for tool-definition token estimates.
 */
export function lenientToolSchema<S extends ObjectSchema>(
  schema: S,
  toolName: string
): Schema<z.output<S>> & { toJSONSchema: () => unknown } {
  const validKeys = Object.keys(schema.shape);
  const providerSchema = zodSchema(schema);
  const lenient = jsonSchema<z.output<S>>(() => providerSchema.jsonSchema, {
    validate: (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { success: false, error: new Error(`Invalid ${toolName} input: expected a JSON object.`) };
      }
      const coerced = coerceLenientValues(schema, value as Record<string, unknown>);
      const { known, ignored } = splitUnknownFields(coerced, validKeys);
      const parsed = schema.safeParse(known);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => {
            const path = issue.path.join(".");
            const got = issue.path.length === 1 ? (known as Record<string, unknown>)[String(issue.path[0])] : undefined;
            return `${path || "input"}: ${issue.message}${got !== undefined ? ` (got ${JSON.stringify(got)})` : ""}`;
          })
          .join("; ");
        return { success: false, error: new Error(`Invalid ${toolName} input: ${issues}. Valid filters: ${validKeys.join(", ")}.`) };
      }
      const extras = Object.fromEntries(ignored.map((key) => [key, coerced[key]]));
      return { success: true, value: { ...extras, ...(parsed.data as object) } as z.output<S> };
    }
  });
  return Object.assign(lenient, { toJSONSchema: () => providerSchema.jsonSchema });
}

/** Formats a catalog price with the scope's currency symbol, e.g. ₹25,199 or $129.99. */
export function formatPrice(amount: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}
