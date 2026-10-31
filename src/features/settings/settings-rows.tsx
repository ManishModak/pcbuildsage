"use client";

import { useId, type ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { Toggle, type FieldControlProps } from "@/components/ui/primitives";

/**
 * A titled group of settings, drawn as one bordered panel with a divider
 * between rows (SettingsRow, SettingsToggleRow, or any full-width content).
 */
export function SettingsGroup({
  title,
  description,
  children,
  className
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-col gap-1 px-1">
        <h2 className="type-title text-lg text-text">{title}</h2>
        {description ? <p className="text-sm text-text-secondary">{description}</p> : null}
      </div>
      <div className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">{children}</div>
    </section>
  );
}

/**
 * One setting: its name and what it does on the left, its control on the
 * right. `stacked` puts a wide control (a key field, a list) under the text.
 * Phones always stack. The render prop gets the id that labels the control.
 */
export function SettingsRow({
  title,
  description,
  stacked = false,
  children,
  footer
}: {
  title: string;
  description?: ReactNode;
  stacked?: boolean;
  children: (controlProps: FieldControlProps) => ReactNode;
  /** A result or status line under the whole row. */
  footer?: ReactNode;
}) {
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5">
      <div className={cn("flex flex-col gap-3", !stacked && "sm:flex-row sm:items-center sm:justify-between sm:gap-6")}>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <label htmlFor={id} className="text-sm font-medium text-text">
            {title}
          </label>
          {description ? (
            <p id={descriptionId} className="text-caption text-text-secondary">
              {description}
            </p>
          ) : null}
        </div>
        <div className={cn("min-w-0", !stacked && "sm:w-64 sm:shrink-0")}>
          {children({ id, "aria-describedby": descriptionId })}
        </div>
      </div>
      {footer}
    </div>
  );
}

/**
 * A row whose control is a button (check, export, open setup). The title is
 * plain text, not a label: a label would press the button when clicked.
 */
export function SettingsActionRow({
  title,
  description,
  children,
  footer
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-sm font-medium text-text">{title}</p>
          {description ? <p className="text-caption text-text-secondary">{description}</p> : null}
        </div>
        <div className="flex shrink-0 sm:justify-end">{children}</div>
      </div>
      {footer}
    </div>
  );
}

/** A switch row: name and description on the left, the switch on the right. */
export function SettingsToggleRow(props: Parameters<typeof Toggle>[0]) {
  return (
    <div className="px-4 py-3.5">
      <Toggle {...props} />
    </div>
  );
}
