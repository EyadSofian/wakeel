/** Renders the supplied artwork; the asset URL stays in the consuming application's brand config. */
export function BrandMark({ src, size = "md" }: { src: string; size?: "sm" | "md" }) {
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      width="1000"
      height="600"
      className={`${size === "sm" ? "h-icon-lg w-tile" : "h-tile-sm w-tile-lg"} shrink-0 object-contain`}
    />
  );
}

export function Brand({ name, markSrc }: { name: string; markSrc: string }) {
  return (
    <span className="flex items-center gap-4">
      <BrandMark src={markSrc} />
      <span className="text-title font-semibold text-primary">{name}</span>
    </span>
  );
}
