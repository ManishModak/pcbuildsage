"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/components/ui/cn";

/** What the user sees when a build cannot be drawn. */
export const BUILD_DISPLAY_ERROR_MESSAGE = "Couldn't display this build";

type BuildErrorBoundaryProps = {
  children: ReactNode;
  /**
   * Values that identify what is being drawn. When any of them changes, a
   * caught error is cleared, so picking a different build version (or a
   * different message) recovers instead of leaving a permanently broken card.
   */
  resetKeys?: unknown[];
  className?: string;
};

type BuildErrorBoundaryState = { error: Error | null };

function keysEqual(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
}

/**
 * Keeps one bad build from taking the chat down with it.
 *
 * Build data comes from a scraped catalog and from model output, and both can
 * hold fields with the wrong shape: a single unexpected value used to throw
 * while drawing the card and blank the whole panel. This is a class component
 * because error boundaries are - React 19 has no hook equivalent and the repo
 * ships no boundary library.
 */
export class BuildErrorBoundary extends Component<BuildErrorBoundaryProps, BuildErrorBoundaryState> {
  state: BuildErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BuildErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // A render failure is otherwise invisible: React swallows it and the panel
    // just goes quiet.
    console.error("Build display failed:", error, info.componentStack);
  }

  componentDidUpdate(prevProps: BuildErrorBoundaryProps): void {
    if (this.state.error === null) return;
    if (keysEqual(prevProps.resetKeys, this.props.resetKeys)) return;
    this.setState({ error: null });
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          role="alert"
          className={cn(
            "flex items-start gap-2 rounded-card border border-border bg-surface px-4 py-3 text-sm text-text-secondary",
            this.props.className
          )}
        >
          <Icon icon={TriangleAlert} size={16} className="mt-0.5 shrink-0" />
          <span>
            {BUILD_DISPLAY_ERROR_MESSAGE}. Ask the assistant to present the build again.
          </span>
        </div>
      );
    }
    return this.props.children;
  }
}
