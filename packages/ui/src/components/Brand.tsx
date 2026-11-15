/**
 * The product mark (ADR-017): an accent tile holding two joined nodes, the thing the Studio builds.
 * Flat, one colour, no gradient. The name comes from @wakeel/config/brand so it changes in one place.
 */
export function BrandMark({ size = "md" }: { size?: "sm" | "md" }) {
  return (
    <svg
      viewBox="0 0 28 28"
      aria-hidden="true"
      className={`${size === "sm" ? "size-tile-sm" : "size-tile"} shrink-0 text-accent`}
    >
      <rect width="28" height="28" rx="8" fill="currentColor" />
      <g className="text-on-accent" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <rect x="6.5" y="7" width="7" height="6" rx="2" />
        <rect x="14.5" y="15" width="7" height="6" rx="2" />
        <path d="M13.5 10h2.5a2 2 0 0 1 2 2v3" />
      </g>
    </svg>
  );
}

export function Brand({ name }: { name: string }) {
  return (
    <span className="flex items-center gap-4">
      <BrandMark />
      <span className="text-title font-semibold text-primary">{name}</span>
    </span>
  );
}
