// The brand mark: a leaf whose veins are PCB traces. Organic wisdom + silicon.
export function LeafMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
      style={{ color: "var(--accent)" }}
    >
      {/* leaf silhouette */}
      <path
        d="M12 21c-4.5-1-8-4.8-8-10.2C4 6 7.2 3 12 3s8 3 8 7.8C20 16.2 16.5 20 12 21Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {/* midrib trace */}
      <path d="M12 20V6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      {/* vein traces */}
      <path
        d="M12 10.5 8.4 8m3.6 6.5L8 12m4-1.5 3.6-2.5M12 14.5l4-2.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {/* trace nodes */}
      <circle cx="8.4" cy="8" r="1.1" fill="currentColor" />
      <circle cx="15.6" cy="8" r="1.1" fill="currentColor" />
      <circle cx="8" cy="12" r="1.1" fill="currentColor" />
      <circle cx="16" cy="12" r="1.1" fill="currentColor" />
      <circle cx="12" cy="6" r="1.2" fill="currentColor" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className}>
      <span className="font-semibold text-text">PCBuild</span>
      <span className="font-semibold" style={{ color: "var(--accent)" }}>
        Sage
      </span>
    </span>
  );
}
