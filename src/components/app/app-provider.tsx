"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchThemes } from "@/lib/api-client";
import { DEFAULT_CONFIG, loadConfig, saveConfig, validateConfig } from "@/lib/client-config-store";
import { applyTheme, pickTheme } from "@/lib/theme";
import type { ClientConfig, ThemeFile } from "@/types/client";

export type ThemeCatalogState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; themes: ThemeFile[] };

type AppContextValue = {
  config: ClientConfig;
  themeCatalog: ThemeCatalogState;
  ready: boolean;
  updateConfig: (patch: Partial<ClientConfig> | ((prev: ClientConfig) => ClientConfig)) => void;
  setTheme: (name: string) => void;
  headerSuffix: ReactNode;
  setHeaderSuffix: (suffix: ReactNode) => void;
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  // null = not yet hydrated from localStorage.
  const [storedConfig, setConfig] = useState<ClientConfig | null>(null);
  const [themeCatalog, setThemeCatalog] = useState<ThemeCatalogState>({ status: "loading" });
  const [headerSuffix, setHeaderSuffix] = useState<ReactNode>(null);
  const config = storedConfig ?? DEFAULT_CONFIG;
  const ready = storedConfig !== null;
  const themes = useMemo(
    () => themeCatalog.status === "ready" ? themeCatalog.themes : [],
    [themeCatalog]
  );

  // Hydrate config from localStorage on mount (client-only to avoid SSR mismatch).
  useEffect(() => {
    const stored = loadConfig();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from localStorage; must run post-mount so SSR HTML and the first client render match
    setConfig(stored);
    fetchThemes()
      .then((list) => {
        setThemeCatalog({ status: "ready", themes: list });
        applyTheme(pickTheme(list, stored.theme));
      })
      .catch((error) => {
        setThemeCatalog({
          status: "error",
          message: error instanceof Error ? error.message : "Could not load themes."
        });
        // Themes endpoint unreachable: the sage-dark defaults in globals.css stand.
      });
  }, []);

  // Synchronize configuration across open browser tabs
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === "pcbuildsage:config" && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue);
          const validated = validateConfig(parsed);
          setConfig(validated);
          if (validated.theme && themes.length > 0) {
            applyTheme(pickTheme(themes, validated.theme));
          }
        } catch {
          // Ignore malformed storage updates
        }
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [themes]);

  const updateConfig = useCallback<AppContextValue["updateConfig"]>(
    (patch) => {
      setConfig((prev) => {
        const base = prev ?? DEFAULT_CONFIG;
        const next = typeof patch === "function" ? patch(base) : { ...base, ...patch };
        saveConfig(next);
        return next;
      });
    },
    []
  );

  const setTheme = useCallback(
    (name: string) => {
      applyTheme(pickTheme(themes, name));
      setConfig((prev) => {
        const next = { ...(prev ?? DEFAULT_CONFIG), theme: name };
        saveConfig(next);
        return next;
      });
    },
    [themes]
  );

  const value = useMemo<AppContextValue>(
    () => ({ config, themeCatalog, ready, updateConfig, setTheme, headerSuffix, setHeaderSuffix }),
    [config, themeCatalog, ready, updateConfig, setTheme, headerSuffix]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used within AppProvider");
  return context;
}
