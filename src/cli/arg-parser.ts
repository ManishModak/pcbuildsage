export type ParsedArgs = {
  command?: string;
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
};

const BOOLEAN_FLAGS = new Set(["json", "quick", "headed", "llmFallback", "noLlmFallback"]);

export function parseArgv(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: ParsedArgs["flags"] = {};
  let command: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith("--")) {
      const raw = token.slice(2);
      const [namePart, inlineValue] = raw.split(/=(.*)/s).filter((part) => part !== undefined);
      const isNegated = namePart.startsWith("no-");
      const name = toCamelCase(isNegated ? namePart.slice(3) : namePart);
      const next = argv[index + 1];
      const value = isNegated
        ? false
        : inlineValue ?? (BOOLEAN_FLAGS.has(name) ? true : (next && !next.startsWith("-") ? argv[++index] : true));
      setFlag(flags, name, value);
      continue;
    }

    if (!command) {
      command = token;
    } else {
      positionals.push(token);
    }
  }

  return { command, positionals, flags };
}

export function stringFlag(flags: ParsedArgs["flags"], name: string): string | undefined {
  const value = flags[name];
  if (Array.isArray(value)) return value.at(-1);
  return typeof value === "string" ? value : undefined;
}

export function booleanFlag(flags: ParsedArgs["flags"], name: string, fallback = false): boolean {
  const value = flags[name];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  return fallback;
}

export function numberFlag(flags: ParsedArgs["flags"], name: string): number | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} expects a number.`);
  return parsed;
}

export function csvFlag(flags: ParsedArgs["flags"], name: string): string[] | undefined {
  const value = stringFlag(flags, name);
  if (!value) return undefined;
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function setFlag(flags: ParsedArgs["flags"], name: string, value: string | boolean): void {
  const previous = flags[name];
  if (previous === undefined) {
    flags[name] = value;
  } else if (Array.isArray(previous)) {
    previous.push(String(value));
  } else {
    flags[name] = [String(previous), String(value)];
  }
}

function toCamelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}
