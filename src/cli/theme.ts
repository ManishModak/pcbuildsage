import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const STATUS_GLYPHS = {
  ok: "✓",
  blocking: "✗",
  warn: "⚠",
  unverified: "◇"
} as const;

export type ThemeAnsi = {
  accent: number;
  ok: number;
  blocking: number;
  warn: number;
  unverified: number;
  muted: number;
};

export type Palette = {
  enabled: boolean;
  accent: (value: string) => string;
  ok: (value: string) => string;
  blocking: (value: string) => string;
  warn: (value: string) => string;
  unverified: (value: string) => string;
  muted: (value: string) => string;
};

export function loadThemeAnsi(themeName = "sage-dark", dir = path.join(process.cwd(), "data", "themes")): ThemeAnsi {
  const filePath = path.join(dir, `${themeName}.json`);
  const data = JSON.parse(readFileSync(filePath, "utf8")) as { ansi?: Partial<ThemeAnsi> };
  return {
    accent: data.ansi?.accent ?? 114,
    ok: data.ansi?.ok ?? 114,
    blocking: data.ansi?.blocking ?? 167,
    warn: data.ansi?.warn ?? 173,
    unverified: data.ansi?.unverified ?? 139,
    muted: data.ansi?.muted ?? 244
  };
}

export function listThemes(dir = path.join(process.cwd(), "data", "themes")): string[] {
  return readdirSync(dir).filter((file) => file.endsWith(".json")).map((file) => file.replace(/\.json$/, "")).sort();
}

export function shouldUseColor(env: NodeJS.ProcessEnv = process.env, stream: NodeJS.WriteStream = process.stdout): boolean {
  return !("NO_COLOR" in env) && Boolean(stream.isTTY);
}

export function createPalette(themeName = "sage-dark", options: { env?: NodeJS.ProcessEnv; stream?: NodeJS.WriteStream } = {}): Palette {
  const enabled = shouldUseColor(options.env, options.stream);
  const ansi = loadThemeAnsi(themeName);
  return {
    enabled,
    accent: color(enabled, ansi.accent),
    ok: color(enabled, ansi.ok),
    blocking: color(enabled, ansi.blocking),
    warn: color(enabled, ansi.warn),
    unverified: color(enabled, ansi.unverified),
    muted: color(enabled, ansi.muted)
  };
}

export function banner(version: string, palette: Palette): string {
  return [
    palette.accent("  .- pcbuildsage"),
    palette.accent(" /_\\ leaf-trace"),
    `${palette.muted(`v${version}`)} ${STATUS_GLYPHS.ok} terminal client`
  ].join("\n");
}

function color(enabled: boolean, code: number): (value: string) => string {
  return (value: string) => enabled ? `\u001B[38;5;${code}m${value}\u001B[0m` : value;
}
