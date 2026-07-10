import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { forwardRef, useId } from "react";
import type { LucideIcon } from "lucide-react";
import { Loader2 } from "lucide-react";
import { cn } from "./cn";
import { Icon } from "./icon";

type ButtonVariant = "primary" | "ghost" | "quiet" | "danger";
type ButtonSize = "md" | "sm";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-btn font-medium transition-colors duration-150 disabled:opacity-50 disabled:pointer-events-none select-none";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent hover:opacity-90",
  ghost: "border border-border bg-transparent text-text hover:bg-surface-raised",
  quiet: "bg-transparent text-text-secondary hover:bg-surface-raised hover:text-text",
  danger: "border border-border bg-transparent text-blocking hover:bg-surface-raised"
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  md: "min-h-11 px-4 text-sm",
  sm: "min-h-9 px-3 text-caption"
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  iconLeft?: LucideIcon;
  iconRight?: LucideIcon;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, iconLeft, iconRight, className, children, disabled, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      className={cn(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Icon icon={Loader2} className="pcbs-spin" /> : iconLeft ? <Icon icon={iconLeft} /> : null}
      {children}
      {iconRight && !loading ? <Icon icon={iconRight} /> : null}
    </button>
  );
});

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
  size?: number;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 18, className, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-11 w-11 items-center justify-center rounded-btn text-text-secondary transition-colors duration-150 hover:bg-surface-raised hover:text-text disabled:opacity-40 disabled:pointer-events-none",
        className
      )}
      {...props}
    >
      <Icon icon={icon} size={size} />
    </button>
  );
});

const FIELD_BASE =
  "w-full min-h-11 rounded-btn border border-border bg-surface px-3 text-base text-text placeholder:text-text-muted transition-colors duration-150 focus:border-accent";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(
  function Input({ className, mono, ...props }, ref) {
    return <input ref={ref} className={cn(FIELD_BASE, mono && "font-mono", className)} {...props} />;
  }
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(FIELD_BASE, "py-3 leading-relaxed", className)} {...props} />;
  }
);

export function Field({
  label,
  hint,
  htmlFor,
  children,
  error
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
  error?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-caption font-medium text-text-secondary">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-caption text-warn">{error}</p>
      ) : hint ? (
        <p className="text-caption text-text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function Card({
  className,
  children,
  as: Tag = "div"
}: {
  className?: string;
  children: ReactNode;
  as?: "div" | "section" | "article";
}) {
  return (
    <Tag className={cn("rounded-card border border-border bg-surface", className)}>{children}</Tag>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = description ? `${id}-description` : undefined;
  return (
    <div className={cn("flex items-start justify-between gap-4", disabled && "opacity-50")}>
      <span
        className={cn("flex flex-col gap-0.5", !disabled && "cursor-pointer")}
        onClick={() => {
          if (!disabled) onChange(!checked);
        }}
      >
        <span id={labelId} className="text-sm text-text">{label}</span>
        {description ? (
          <span id={descriptionId} className="text-caption text-text-secondary">
            {description}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-pill border transition-colors duration-150",
          checked ? "border-accent bg-accent" : "border-border bg-surface-raised"
        )}
      >
        <span
          className={cn(
            "inline-block h-4 w-4 rounded-pill bg-bg transition-transform duration-150",
            checked ? "translate-x-6" : "translate-x-1"
          )}
          style={checked ? { backgroundColor: "var(--on-accent)" } : undefined}
        />
      </button>
    </div>
  );
}

export function Spinner({ className, size = 16 }: { className?: string; size?: number }) {
  return <Icon icon={Loader2} size={size} className={cn("pcbs-spin text-text-secondary", className)} />;
}

export function ProgressBar({
  value,
  tone = "accent",
  className
}: {
  /** 0–100, or undefined for indeterminate. */
  value?: number;
  tone?: "accent" | "warn" | "blocking";
  className?: string;
}) {
  const toneColor = tone === "warn" ? "var(--warn)" : tone === "blocking" ? "var(--blocking)" : "var(--accent)";
  const clamped = value === undefined ? undefined : Math.max(0, Math.min(100, value));
  return (
    <div
      className={cn("relative h-2 overflow-hidden rounded-pill bg-surface-raised", className)}
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {clamped === undefined ? (
        <span
          className="absolute inset-y-0 left-0 w-1/4 rounded-pill"
          style={{ background: toneColor, animation: "pcbs-indeterminate 1.2s ease-in-out infinite" }}
        />
      ) : (
        <span
          className="absolute inset-y-0 left-0 rounded-pill transition-[width] duration-200 ease-out"
          style={{ width: `${clamped}%`, background: toneColor }}
        />
      )}
    </div>
  );
}

export function Chip({
  children,
  className,
  onClick,
  active,
  as
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  active?: boolean;
  as?: "button" | "span";
}) {
  const Tag = as ?? (onClick ? "button" : "span");
  return (
    <Tag
      onClick={onClick}
      type={Tag === "button" ? "button" : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-chip border px-2.5 py-1 font-mono text-caption",
        active ? "border-accent text-text" : "border-border text-text-secondary",
        onClick && "transition-colors duration-150 hover:border-accent hover:text-text",
        className
      )}
    >
      {children}
    </Tag>
  );
}
