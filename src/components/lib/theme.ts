import type { ThemeFile } from "./types";

// Semantic token names a theme file must provide. Components consume only these.
export const TOKEN_KEYS = [
  "--bg",
  "--surface",
  "--surface-raised",
  "--border",
  "--text",
  "--text-secondary",
  "--text-muted",
  "--accent",
  "--on-accent",
  "--ok",
  "--blocking",
  "--warn",
  "--unverified"
] as const;

export type ResolvedTheme = {
  name: string;
  mode: "dark" | "light";
  tokens: Record<string, string>;
};

const SAGE_DARK: ResolvedTheme = {
  name: "sage-dark",
  mode: "dark",
  tokens: {
    "--bg": "#0E1210",
    "--surface": "#161B18",
    "--surface-raised": "#1D2420",
    "--border": "#2A332E",
    "--text": "#E8EDE9",
    "--text-secondary": "#9DAAA2",
    "--text-muted": "#67736B",
    "--accent": "#7DC383",
    "--on-accent": "#0B130D",
    "--ok": "#7DC383",
    "--blocking": "#E5735F",
    "--warn": "#E0B25D",
    "--unverified": "#B195E8"
  }
};

export function resolveTheme(theme: ThemeFile): ResolvedTheme {
  const tokens: Record<string, string> = {};
  for (const key of TOKEN_KEYS) {
    tokens[key] = theme.tokens?.[key] ?? SAGE_DARK.tokens[key];
  }
  return {
    name: theme.theme_name ?? theme.id,
    mode: theme.mode === "light" ? "light" : "dark",
    tokens
  };
}

export function pickTheme(themes: ThemeFile[], name: string): ResolvedTheme {
  const match = themes.find((theme) => (theme.theme_name ?? theme.id) === name || theme.id === name);
  if (match) return resolveTheme(match);
  // Fall back to prefers-color-scheme between the two built-ins only.
  const prefersLight =
    typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches;
  const builtin = themes.find(
    (theme) => (theme.theme_name ?? theme.id) === (prefersLight ? "sage-light" : "sage-dark")
  );
  return builtin ? resolveTheme(builtin) : SAGE_DARK;
}

/** Apply a resolved theme to <html> and cache it for the anti-FOUC bootstrap. */
export function applyTheme(theme: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(key, value);
  }
  root.setAttribute("data-theme", theme.name);
  root.setAttribute("data-theme-mode", theme.mode);
  try {
    localStorage.setItem(
      "pcbuildsage:themeTokens",
      JSON.stringify({ name: theme.name, mode: theme.mode, tokens: theme.tokens })
    );
  } catch {
    // Storage may be unavailable (private mode); theme still applies in-memory.
  }
}

export const DEFAULT_THEME = SAGE_DARK;
