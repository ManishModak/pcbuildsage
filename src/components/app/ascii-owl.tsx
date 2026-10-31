import { cn } from "@/components/ui/cn";

// The sage's owl, perched on a branch in ASCII. It blinks every few seconds
// (CSS only, .owl-eyes / .owl-lids in globals.css) and holds still for
// reduced motion. Decorative: hidden from screen readers.
export function AsciiOwl({ className }: { className?: string }) {
  return (
    <pre
      aria-hidden="true"
      className={cn("select-none font-mono text-[13px] leading-[1.15] text-text-muted", className)}
    >
      {"   ,_,\n  "}
      <span className="inline-grid">
        <span className="owl-eyes [grid-area:1/1]">(o,o)</span>
        <span className="owl-lids [grid-area:1/1]">(-,-)</span>
      </span>
      {"\n  (   )\n---\"-\"----"}
    </pre>
  );
}
