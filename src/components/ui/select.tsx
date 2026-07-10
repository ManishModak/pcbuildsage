import { forwardRef, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "./cn";
import { Icon } from "./icon";

export type SelectOption = { value: string; label: string; disabled?: boolean };

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & { options: SelectOption[]; placeholder?: string }
>(function Select({ options, placeholder, className, ...props }, ref) {
  return (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          "w-full min-h-11 appearance-none rounded-btn border border-border bg-surface px-3 pr-9 text-sm text-text transition-colors duration-150 focus:border-accent",
          className
        )}
        {...props}
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary">
        <Icon icon={ChevronDown} size={16} />
      </span>
    </div>
  );
});
