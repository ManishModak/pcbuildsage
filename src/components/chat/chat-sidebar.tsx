"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, Copy, MessageSquare, MessageSquarePlus, Settings, Trash2 } from "lucide-react";
import { formatRelativeTime } from "../lib/format";
import type { SessionSummary } from "../lib/types";
import { cn } from "../ui/cn";
import { Icon } from "../ui/icon";
import { LeafMark, Wordmark } from "../app/brand";
import { ThemeSwitcher } from "../app/theme-switcher";
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuAction,
  SidebarFooter,
  SidebarRail,
  SidebarTrigger
} from "@/components/animate-ui/components/radix/sidebar";

// Neutral hover for the base shadcn Button (ghost) behind SidebarTrigger:
// twMerge overrides the component's default green `hover:bg-accent`.
const TRIGGER_HOVER = "hover:bg-surface-raised hover:text-text";

/**
 * Chat history sidebar rebuilt on the animate-ui radix Sidebar primitives:
 * brand + collapse trigger in the header, a "New chat" action, and the saved
 * sessions as an animated menu (active = current session, delete on hover).
 * Desktop collapses to an icon rail; mobile uses the component's built-in Sheet.
 */
export function ChatSidebar({
  sessions,
  currentSessionId,
  onNew,
  onSelect,
  onDelete
}: {
  sessions: SessionSummary[];
  currentSessionId: string;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-14 flex-row items-center justify-between border-b border-border px-2">
        <Link
          href="/"
          className="flex items-center gap-2 rounded-btn px-1"
          aria-label="PCBuildSage home"
        >
          <LeafMark size={22} />
          <Wordmark className="text-base group-data-[collapsible=icon]:hidden" />
        </Link>
        <SidebarTrigger className={cn("group-data-[collapsible=icon]:hidden", TRIGGER_HOVER)} />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="New chat" onClick={onNew}>
                <Icon icon={MessageSquarePlus} size={16} />
                <span>New chat</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Chats</SidebarGroupLabel>
          <SidebarGroupContent>
            {sessions.length === 0 ? (
              <p className="px-2 py-4 text-caption text-text-muted group-data-[collapsible=icon]:hidden">
                No saved chats yet.
              </p>
            ) : (
              <SidebarMenu>
                {sessions.map((session) => {
                  const title = session.title || "New chat";
                  const active = session.id === currentSessionId;
                  return (
                    <SidebarMenuItem key={session.id}>
                      <SidebarMenuButton
                        size="lg"
                        isActive={active}
                        tooltip={title}
                        onClick={() => onSelect(session.id)}
                        aria-current={active ? "true" : undefined}
                      >
                        <Icon icon={MessageSquare} size={16} />
                        {/* Hide the two-line label when the rail collapses to
                            icons, otherwise it leaks as stacked text fragments. */}
                        <span className="flex min-w-0 flex-col group-data-[collapsible=icon]:hidden">
                          <span className="truncate text-sm text-text">{title}</span>
                          <span className="truncate text-caption text-text-muted">
                            {formatRelativeTime(session.updated_at)}
                          </span>
                        </span>
                      </SidebarMenuButton>
                      <SidebarMenuAction
                        showOnHover
                        aria-label="Copy session ID"
                        title="Copy session ID"
                        className={cn(TRIGGER_HOVER, "text-text-secondary right-8")}
                        onClick={(e) => {
                          e.stopPropagation();
                          void navigator.clipboard.writeText(session.id);
                          setCopiedId(session.id);
                          setTimeout(() => setCopiedId(null), 2000);
                        }}
                      >
                        <Icon icon={copiedId === session.id ? Check : Copy} size={13} className={copiedId === session.id ? "text-accent" : ""} />
                      </SidebarMenuAction>
                      <SidebarMenuAction
                        showOnHover
                        aria-label="Delete chat"
                        title="Delete chat"
                        className={cn(TRIGGER_HOVER, "text-text-secondary")}
                        onClick={() => {
                          if (window.confirm(`Delete "${title}"? This can't be undone.`)) onDelete(session.id);
                        }}
                      >
                        <Icon icon={Trash2} size={14} />
                      </SidebarMenuAction>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Settings">
              <Link href="/settings">
                <Icon icon={Settings} size={16} />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <ThemeSwitcher variant="sidebar" />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
