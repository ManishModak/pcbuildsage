"use client";

import { useEffect, useRef, type MouseEvent, type ReactNode, type SyntheticEvent } from "react";
import { X } from "lucide-react";
import { cn } from "./cn";
import { IconButton } from "./primitives";

// Modal built on the native <dialog> element: showModal() gives us focus
// trapping, top-layer stacking, Escape handling, and focus restoration for
// free. React state stays the source of truth — native cancel/close events
// are forwarded to onClose. Surface-raised panel, 50% black scrim via
// ::backdrop, scale+fade entrance (0.98) — see .pcbs-dialog in globals.css.
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Escape pressed: keep the dialog open at the native level and let React
  // state drive the actual close (the effect above calls dialog.close()).
  const handleCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    onClose();
  };

  // Fired when the dialog closes natively (e.g. a forced close the cancel
  // handler could not prevent). Idempotent when state is already closed.
  const handleClose = () => {
    if (open) onClose();
  };

  // Clicks on the ::backdrop register on the <dialog> element itself but land
  // outside its bounding rect — treat those as "click outside to close".
  const handleMouseDown = (event: MouseEvent<HTMLDialogElement>) => {
    const dialog = dialogRef.current;
    if (!dialog || event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const insidePanel =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    if (!insidePanel) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-label={title}
      onCancel={handleCancel}
      onClose={handleClose}
      onMouseDown={handleMouseDown}
      className={cn(
        "pcbs-dialog w-full max-w-lg rounded-card border border-border bg-surface-raised shadow-2xl outline-none",
        className
      )}
      style={{ boxShadow: "0 24px 60px -20px rgba(0,0,0,0.55)" }}
    >
      {/* Mount content only while open so children keep remount-on-open semantics. */}
      {open ? (
        <>
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="flex flex-col gap-1">
              <h2 className="text-lg font-semibold text-text">{title}</h2>
              {description ? <p className="text-caption text-text-secondary">{description}</p> : null}
            </div>
            <IconButton icon={X} label="Close dialog" onClick={onClose} className="-mr-2 -mt-1" />
          </div>
          <div className="px-5 py-4">{children}</div>
          {footer ? <div className="flex justify-end gap-2 border-t border-border px-5 py-4">{footer}</div> : null}
        </>
      ) : null}
    </dialog>
  );
}
