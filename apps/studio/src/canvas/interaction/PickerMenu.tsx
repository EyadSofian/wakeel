import { type Category, enterTransition, IconTile, Kbd, useMotionTokens } from "@wakeel/ui";
import type { LucideIcon } from "lucide-react";
import { Search } from "lucide-react";
import { motion } from "motion/react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";

/**
 * A searchable menu at a screen point (design system §4 NodeAddMenu; the card menu uses it too).
 * Typing filters; arrows move over the enabled items; `Enter` picks; `Esc` or a click outside
 * closes. Unavailable items stay listed, dimmed, with the reason, so builders learn what is there.
 */
export interface PickerItem {
  id: string;
  label: string;
  description: string;
  group: string;
  icon: LucideIcon;
  category: Category;
  /** Why it cannot be picked now. */
  unavailable?: string;
  shortcut?: string;
}

const WIDTH = 320;
const MAX_HEIGHT = 420;

export function PickerMenu({
  label,
  items,
  at,
  initialQuery = "",
  onPick,
  onClose,
}: {
  label: string;
  items: readonly PickerItem[];
  at: { x: number; y: number };
  initialQuery?: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const tokens = useMotionTokens();
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();

  // While searching, results are one list ranked by where the words match: the start of the name,
  // then anywhere in the name, then the description or group. Typing "log" finds Log before Logic.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return items;
    const score = (i: PickerItem) => {
      const label = i.label.toLowerCase();
      if (label.startsWith(q)) return 0;
      if (label.includes(q)) return 1;
      if (`${i.description} ${i.group}`.toLowerCase().includes(q)) return 2;
      return 3;
    };
    return items
      .map((item, index) => ({ item, index, score: score(item) }))
      .filter((x) => x.score < 3)
      .sort((a, b) => a.score - b.score || a.index - b.index)
      .map((x) => x.item);
  }, [items, query]);
  const searching = query.trim() !== "";
  const enabled = visible.filter((i) => !i.unavailable);
  const current = enabled[Math.min(active, enabled.length - 1)];

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [onClose]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (enabled.length === 0 ? 0 : (a + step + enabled.length) % enabled.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (current) onPick(current.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  // Keep the menu on screen: open below and to the end of the point, flip when there is no room.
  const left = Math.max(8, Math.min(at.x, window.innerWidth - WIDTH - 8));
  const top = at.y + MAX_HEIGHT > window.innerHeight - 8 ? Math.max(8, at.y - MAX_HEIGHT) : at.y;
  const groups = searching ? ["Results"] : [...new Set(visible.map((i) => i.group))];

  return (
    <motion.div
      ref={root}
      role="dialog"
      aria-label={label}
      // Position comes from the pointer, so it cannot be a token; colour and spacing are tokens.
      style={{ left, top }}
      initial={{ opacity: 0, y: -tokens.travel }}
      animate={{ opacity: 1, y: 0, transition: enterTransition(tokens, "snappy") }}
      className="nodrag nowheel fixed z-50 flex max-h-picker-height w-picker flex-col overflow-hidden rounded-lg border border-hairline bg-surface shadow-pop"
      onKeyDown={onKeyDown}
    >
      <label className="relative block border-b border-hairline transition-colors focus-within:border-accent">
        <span className="sr-only">{label}</span>
        <Search
          className="pointer-events-none absolute start-5 top-1/2 size-icon -translate-y-1/2 text-tertiary"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <input
          // biome-ignore lint/a11y/noAutofocus: the menu opens to be typed into; Esc returns to the canvas.
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={current ? `${listId}-${current.id}` : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          placeholder="Search"
          dir="auto"
          className="wk-focus-underline h-control-lg w-full bg-transparent pe-5 ps-10 text-body text-primary outline-hidden placeholder:text-tertiary"
        />
      </label>
      <div id={listId} role="listbox" aria-label={label} className="flex flex-col gap-1 overflow-auto p-3">
        {visible.length === 0 ? (
          <p className="px-4 py-6 text-center text-body text-secondary">Nothing matches "{query.trim()}"</p>
        ) : (
          groups.map((g) => (
            // biome-ignore lint/a11y/useSemanticElements: an option group inside a listbox (ARIA), not a form fieldset.
            <div key={g} role="group" aria-label={g} className="flex flex-col gap-1">
              <p className="px-4 pb-1 pt-3 text-small font-medium text-tertiary">{g}</p>
              {visible
                .filter((i) => searching || i.group === g)
                .map((i) => {
                  const selected = i.id === current?.id;
                  return (
                    <div
                      key={i.id}
                      id={`${listId}-${i.id}`}
                      role="option"
                      aria-selected={selected}
                      aria-disabled={i.unavailable ? true : undefined}
                      tabIndex={-1}
                      onMouseEnter={() => !i.unavailable && setActive(enabled.indexOf(i))}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => !i.unavailable && onPick(i.id)}
                      onKeyDown={() => undefined}
                      className={[
                        "flex items-center gap-4 rounded-sm px-3 py-2",
                        i.unavailable ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                        selected ? "bg-accent-subtle" : "",
                      ].join(" ")}
                    >
                      <IconTile category={i.category} icon={i.icon} size="sm" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-body font-medium text-primary">{i.label}</span>
                        <span className="truncate text-small text-secondary">{i.unavailable ?? i.description}</span>
                      </span>
                      {i.shortcut ? <Kbd>{i.shortcut}</Kbd> : null}
                    </div>
                  );
                })}
            </div>
          ))
        )}
      </div>
    </motion.div>
  );
}
