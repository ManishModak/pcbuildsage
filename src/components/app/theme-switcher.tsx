"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Moon, Palette, Sun } from "lucide-react";
import { cn } from "../ui/cn";
import { Icon } from "../ui/icon";
import { IconButton } from "../ui/primitives";
import { SidebarMenuButton } from "@/components/animate-ui/components/radix/sidebar";
import { useApp } from "./app-provider";

// Compact theme picker. In the app shell header it's an icon button whose menu
// opens downward; in the sidebar footer (`variant="sidebar"`) it's a labeled
// menu row whose menu opens upward. Switching swaps the CSS variable set on
// <html> with no reload (see applyTheme).
export function ThemeSwitcher({ variant = "bar" }: { variant?: "bar" | "sidebar" }) {
  const { config, themes, setTheme } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inSidebar = variant === "sidebar";

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        // Escape may fire while focus is inside the menu, which unmounts —
        // return focus to the trigger so keyboard users are not stranded.
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={cn("relative", inSidebar && "w-full")} ref={ref}>
      {inSidebar ? (
        <SidebarMenuButton
          tooltip="Theme"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
        >
          <Icon icon={Palette} size={16} />
          <span>Theme</span>
        </SidebarMenuButton>
      ) : (
        <IconButton
          ref={triggerRef}
          icon={Palette}
          label="Change theme"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
        />
      )}
      {open ? (
        <div
          role="menu"
          className={cn(
            "pcbs-fade-in absolute z-40 w-52 rounded-card border border-border bg-surface-raised p-1 shadow-xl",
            inSidebar ? "bottom-full left-0 mb-2" : "right-0 top-12"
          )}
          style={{ boxShadow: "0 20px 48px -18px rgba(0,0,0,0.5)" }}
        >
          {themes.length === 0 ? (
            <p className="px-3 py-2 text-caption text-text-muted">No themes found</p>
          ) : (
            themes.map((theme) => {
              const name = theme.theme_name ?? theme.id;
              const active = name === config.theme;
              return (
                <button
                  key={theme.id}
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => {
                    setTheme(name);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-btn px-3 py-2 text-left text-sm transition-colors duration-150 hover:bg-surface",
                    active ? "text-text" : "text-text-secondary"
                  )}
                >
                  <Icon icon={theme.mode === "light" ? Sun : Moon} size={15} />
                  <span className="flex-1 truncate">{name}</span>
                  {active ? <Icon icon={Check} size={15} className="text-accent" /> : null}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
