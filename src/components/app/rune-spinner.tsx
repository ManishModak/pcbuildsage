import { cn } from "@/components/ui/cn";

// A single rune that keeps changing, used where work is in progress (a tool
// call running, a model being checked). Decorative: pair it with visible or
// screen-reader text that says what is happening.
export function RuneSpinner({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("rune-spinner inline-block", className)} />;
}
