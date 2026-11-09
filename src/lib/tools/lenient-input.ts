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

/**
 * Accepts an array or object argument sent as a JSON string, which some models
 * do for nested arguments (Nemotron sent `builds` as "[{...}]"). The JSON
 * schema the model sees is unchanged; only validation is lenient.
 */
export function parsedJson<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return leadingJsonValue(value) ?? value;
    }
  }, schema);
}

/**
 * Parses the array or object a string starts with, ignoring whatever follows
 * it: Nemotron Lightning sent `builds` as "[{...}]}" with a stray closing
 * brace, and as "[{...}}]}" with the object's closing brace after the `]`.
 * A closer that skips an open bracket gets the missing closers inserted
 * before it, and a closer matching nothing open is dropped. Returns undefined
 * when the string doesn't start with a complete array or object.
 */
export function leadingJsonValue(text: string): unknown {
  return leadingJson(text)?.value;
}

/**
 * leadingJsonValue's parse plus `rest`: the text after the value, so a caller
 * can require that nothing but stray closers follows it.
 */
export function leadingJson(text: string): { value: unknown; rest: string } | undefined {
  const start = text.search(/\S/);
  if (start < 0 || (text[start] !== "[" && text[start] !== "{")) return undefined;
  const closers: string[] = [];
  let repaired = "";
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      repaired += ch;
      if (ch === "\\") repaired += text[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      repaired += ch;
      inString = true;
    } else if (ch === "[" || ch === "{") {
      repaired += ch;
      closers.push(ch === "[" ? "]" : "}");
    } else if (ch === "]" || ch === "}") {
      if (!closers.includes(ch)) continue;
      while (closers.at(-1) !== ch) repaired += closers.pop();
      repaired += closers.pop();
      if (closers.length === 0) {
        try {
          return { value: JSON.parse(repaired) as unknown, rest: text.slice(i + 1) };
        } catch {
          return undefined;
        }
      }
    } else {
      repaired += ch;
    }
  }
  return undefined;
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
 * A rejected call names one issue per field (the first) and ends with `hint`
 * when given, else the list of valid filters. `prepare` runs first, on the
 * raw input.
 */
export function lenientToolSchema<S extends ObjectSchema>(
  schema: S,
  toolName: string,
  hint?: string,
  /** Tool-specific cleanup of the raw input before coercion and validation. */
  prepare?: (value: Record<string, unknown>) => Record<string, unknown>,
  /** Tool-specific change to the JSON schema providers are sent; validation still uses `schema`. */
  forProvider?: (jsonSchema: Record<string, unknown>) => Record<string, unknown>
): Schema<z.output<S>> & { toJSONSchema: () => unknown } {
  const validKeys = Object.keys(schema.shape);
  const providerSchema = zodSchema(schema);
  // A field wrapped in parsedJson (a preprocess) comes out of zod's JSON
  // Schema as optional, so models skipped it: Nemotron on NIM sent
  // validate_build only {"budget":N} in 7 of 8 calls. Every field that
  // rejects undefined is listed as required.
  const required = Object.keys(schema.shape).filter((key) => !(schema.shape[key] as z.ZodType).safeParse(undefined).success);
  const providerJsonSchema = () => {
    const base = providerSchema.jsonSchema as { required?: string[] };
    const withRequired = required.length ? { ...base, required: [...new Set([...(base.required ?? []), ...required])] } : base;
    return forProvider ? forProvider(withRequired as Record<string, unknown>) : withRequired;
  };
  const lenient = jsonSchema<z.output<S>>(() => providerJsonSchema() as never, {
    validate: (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { success: false, error: new Error(`Invalid ${toolName} input: expected a JSON object.`) };
      }
      const raw = value as Record<string, unknown>;
      const coerced = coerceLenientValues(schema, prepare ? prepare(raw) : raw);
      const { known, ignored } = splitUnknownFields(coerced, validKeys);
      const parsed = schema.safeParse(known);
      if (!parsed.success) {
        // zod can report several issues for one field (a string where an
        // array belongs also fails the array's max length); the first is the real one.
        const seen = new Set<string>();
        const issues = parsed.error.issues
          .filter((issue) => {
            const path = issue.path.join(".");
            if (seen.has(path)) return false;
            seen.add(path);
            return true;
          })
          .map((issue) => {
            const path = issue.path.join(".");
            const got = issue.path.length === 1 ? (known as Record<string, unknown>)[String(issue.path[0])] : undefined;
            const shown = got === undefined ? "" : JSON.stringify(got);
            return `${path || "input"}: ${issue.message}${got !== undefined ? ` (got ${shown.length > 120 ? `${shown.slice(0, 120)}…` : shown})` : ""}`;
          })
          .join("; ");
        return { success: false, error: new Error(`Invalid ${toolName} input: ${issues}. ${hint ?? `Valid filters: ${validKeys.join(", ")}.`}`) };
      }
      const extras = Object.fromEntries(ignored.map((key) => [key, coerced[key]]));
      return { success: true, value: { ...extras, ...(parsed.data as object) } as z.output<S> };
    }
  });
  return Object.assign(lenient, { toJSONSchema: providerJsonSchema });
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
