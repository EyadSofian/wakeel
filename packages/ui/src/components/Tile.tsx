import type { LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * Node categories (ADR-017). The canvas, the node library and the inspector colour a node by its
 * category; nothing else in the Studio uses these colours.
 */
export type Category = "trigger" | "logic" | "ai" | "tool" | "human" | "flow";

/** Static class names, so Tailwind sees every one. */
export const CATEGORY_CLASSES: Record<
  Category,
  { tile: string; icon: string; border: string; port: string; dot: string }
> = {
  trigger: {
    tile: "bg-cat-trigger-subtle text-cat-trigger",
    icon: "text-cat-trigger",
    border: "border-cat-trigger-border",
    port: "wk-port-trigger",
    dot: "bg-cat-trigger",
  },
  logic: {
    tile: "bg-cat-logic-subtle text-cat-logic",
    icon: "text-cat-logic",
    border: "border-cat-logic-border",
    port: "wk-port-logic",
    dot: "bg-cat-logic",
  },
  ai: {
    tile: "bg-cat-ai-subtle text-cat-ai",
    icon: "text-cat-ai",
    border: "border-cat-ai-border",
    port: "wk-port-ai",
    dot: "bg-cat-ai",
  },
  tool: {
    tile: "bg-cat-tool-subtle text-cat-tool",
    icon: "text-cat-tool",
    border: "border-cat-tool-border",
    port: "wk-port-tool",
    dot: "bg-cat-tool",
  },
  human: {
    tile: "bg-cat-human-subtle text-cat-human",
    icon: "text-cat-human",
    border: "border-cat-human-border",
    port: "wk-port-human",
    dot: "bg-cat-human",
  },
  flow: {
    tile: "bg-cat-flow-subtle text-cat-flow",
    icon: "text-cat-flow",
    border: "border-cat-flow-border",
    port: "wk-port-flow",
    dot: "bg-cat-flow",
  },
};

const tileSizes = {
  sm: { box: "size-tile-sm rounded-xs", icon: "size-icon-sm" },
  md: { box: "size-tile rounded-sm", icon: "size-icon" },
  lg: { box: "size-tile-lg rounded-md", icon: "size-icon-lg" },
} as const;

/** A category-coloured square holding a line icon: node headers, the node library, the inspector. */
export function IconTile({
  category,
  icon: Icon,
  size = "md",
}: {
  category: Category;
  icon: LucideIcon;
  size?: keyof typeof tileSizes;
}) {
  const s = tileSizes[size];
  return (
    <span className={`inline-flex shrink-0 items-center justify-center ${s.box} ${CATEGORY_CLASSES[category].tile}`}>
      <Icon className={s.icon} strokeWidth={1.75} aria-hidden="true" />
    </span>
  );
}

/** A filter chip. Pressed chips take the accent; the rest stay quiet. */
export function Chip({
  pressed,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { pressed: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={[
        "inline-flex h-control-sm items-center rounded-full border px-4 text-small font-medium transition-colors",
        pressed
          ? "border-accent bg-accent text-on-accent"
          : "border-hairline bg-surface text-secondary hover:border-strong hover:text-primary",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
}

/** A keyboard key, for shortcut hints in tooltips, menus and search fields. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-tile-sm min-w-tile-sm items-center justify-center rounded-xs border border-hairline bg-subtle px-2 font-sans text-micro text-secondary">
      {children}
    </kbd>
  );
}

/** A count next to a heading: quiet, tabular. */
export function Count({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-tile-sm min-w-tile-sm items-center justify-center rounded-xs bg-muted px-2 text-micro text-secondary tabular-nums">
      {children}
    </span>
  );
}
