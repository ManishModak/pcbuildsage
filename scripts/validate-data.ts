import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { AnySchema } from "ajv";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

type ValidationTarget = {
  name: string;
  schemaPath: string;
  dataDir: string;
  recursive?: boolean;
};

const targets: ValidationTarget[] = [
  {
    name: "registry",
    schemaPath: "data/schemas/registry.schema.json",
    dataDir: "data/registry",
    recursive: true
  },
  {
    name: "profiles",
    schemaPath: "data/schemas/profile.schema.json",
    dataDir: "data/profiles"
  },
  {
    name: "themes",
    schemaPath: "data/schemas/theme.schema.json",
    dataDir: "data/themes"
  },
  {
    name: "personalities",
    schemaPath: "data/schemas/personality.schema.json",
    dataDir: "data/personalities"
  },
  {
    name: "endpoints",
    schemaPath: "data/schemas/endpoint.schema.json",
    dataDir: "data/endpoints"
  },
  {
    name: "search",
    schemaPath: "data/schemas/search.schema.json",
    dataDir: "data/search"
  }
];

const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);

let hasErrors = false;

for (const target of targets) {
  const schema = readJson<AnySchema>(target.schemaPath);

  if (!schema.ok) {
    hasErrors = true;
    continue;
  }

  const validate = ajv.compile(schema.value);
  const files = listJsonFiles(target.dataDir, target.recursive).sort();

  for (const filePath of files) {
    const data = readJson(filePath);

    if (!data.ok) {
      hasErrors = true;
      continue;
    }

    const valid = validate(data.value);

    if (!valid) {
      hasErrors = true;
      console.error(`${filePath} invalid against schema`);
      console.error(ajv.errorsText(validate.errors, { separator: "\n" }));
      continue;
    }

    // Custom semantic validations
    if (target.name === "themes") {
      const theme = data.value as Record<string, unknown>;
      if (theme.tokens) {
        const tokens = theme.tokens as Record<string, string>;
        const bg = tokens["--bg"];
        const surface = tokens["--surface"];
        
        const checks = [
          { name: "--text vs --bg", fg: tokens["--text"], bg: bg, threshold: 4.5 },
          { name: "--text-secondary vs --bg", fg: tokens["--text-secondary"], bg: bg, threshold: 4.5 },
          { name: "--accent vs --bg", fg: tokens["--accent"], bg: bg, threshold: 3.0 },
          { name: "--on-accent vs --accent", fg: tokens["--on-accent"], bg: tokens["--accent"], threshold: 4.5 },
          { name: "--text vs --surface", fg: tokens["--text"], bg: surface, threshold: 4.5 },
        ];

        let themeHasErrors = false;
        for (const check of checks) {
          if (check.fg && check.bg) {
            try {
              const ratio = getContrastRatio(check.fg, check.bg);
              if (ratio < check.threshold) {
                themeHasErrors = true;
                hasErrors = true;
                console.error(`${filePath} invalid: WCAG contrast check failed for ${check.name}. Ratio is ${ratio.toFixed(2)}:1 (minimum ${check.threshold}:1 required).`);
              }
            } catch (err) {
              themeHasErrors = true;
              hasErrors = true;
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`${filePath} invalid: WCAG contrast check failed for ${check.name}. Error parsing colors: ${msg}`);
            }
          }
        }
        if (themeHasErrors) {
          continue;
        }
      }
    }

    console.log(`${filePath} valid`);
  }
}

if (hasErrors) {
  process.exitCode = 1;
}

function listJsonFiles(dir: string, recursive = false): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const entryPath = path.join(dir, entry);
    const stat = statSync(entryPath);

    if (stat.isDirectory() && recursive) {
      files.push(...listJsonFiles(entryPath, true));
      continue;
    }

    if (stat.isFile() && entry.endsWith(".json")) {
      files.push(entryPath);
    }
  }

  return files;
}

function readJson<T = unknown>(filePath: string): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path.resolve(filePath), "utf8")) as T };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${filePath} invalid JSON`);
    console.error(message);
    return { ok: false };
  }
}

function getContrastRatio(hex1: string, hex2: string): number {
  const l1 = getRelativeLuminance(hex1);
  const l2 = getRelativeLuminance(hex2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function getRelativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    throw new Error(`Invalid hex color: "${hex}"`);
  }
  const r = adjustColorChannel(rgb.r);
  const g = adjustColorChannel(rgb.g);
  const b = adjustColorChannel(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  return match
    ? {
        r: parseInt(match[1], 16),
        g: parseInt(match[2], 16),
        b: parseInt(match[3], 16)
      }
    : null;
}

function adjustColorChannel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
