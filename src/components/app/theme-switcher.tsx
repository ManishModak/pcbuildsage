"use client";

import { Check, Moon, Palette, Sun } from "lucide-react";
import { DropdownMenu } from "radix-ui";
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
  const { config, themeCatalog, setTheme } = useApp();
  const inSidebar = variant === "sidebar";

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        {inSidebar ? (
          <SidebarMenuButton type="button">
            <Icon icon={Palette} size={16} />
            <span className="group-data-[collapsible=icon]:hidden">Theme</span>
          </SidebarMenuButton>
        ) : (
          <IconButton icon={Palette} label="Change theme" />
        )}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side={inSidebar ? "top" : "bottom"}
          align={inSidebar ? "start" : "end"}
          sideOffset={8}
          className="pcbs-fade-in z-40 w-52 rounded-card border border-border bg-surface-raised p-1 shadow-xl"
          style={{ boxShadow: "0 20px 48px -18px rgba(0,0,0,0.5)" }}
        >
          {themeCatalog.status === "loading" ? (
            <p className="px-3 py-2 text-caption text-text-muted">Loading themes…</p>
          ) : themeCatalog.status === "error" ? (
            <p className="px-3 py-2 text-caption text-warn" role="alert">Themes unavailable</p>
          ) : themeCatalog.themes.length === 0 ? (
            <p className="px-3 py-2 text-caption text-text-muted">No themes found</p>
          ) : (
            <DropdownMenu.RadioGroup value={config.theme} onValueChange={setTheme}>
              {themeCatalog.themes.map((theme) => {
                const name = theme.theme_name ?? theme.id;
                return (
                  <DropdownMenu.RadioItem
                    key={theme.id}
                    value={name}
                    className={cn(
                      "flex cursor-default items-center gap-2 rounded-btn px-3 py-2 text-sm text-text-secondary outline-none transition-colors duration-150",
                      "data-[highlighted]:bg-surface data-[highlighted]:text-text data-[state=checked]:text-text"
                    )}
                  >
                    <Icon icon={theme.mode === "light" ? Sun : Moon} size={15} />
                    <span className="flex-1 truncate">{name}</span>
                    <DropdownMenu.ItemIndicator>
                      <Icon icon={Check} size={15} className="text-accent" />
                    </DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                );
              })}
            </DropdownMenu.RadioGroup>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
