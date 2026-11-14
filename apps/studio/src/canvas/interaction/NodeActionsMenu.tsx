import { enterTransition, Kbd, useMotionTokens } from "@wakeel/ui";
import { type LucideIcon, Pencil, Play } from "lucide-react";
import { motion } from "motion/react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useRunFrom } from "../../emulator/run-from";
import { useUiStore } from "./ui-store";

interface Action {
  id: string;
  label: string;
  icon: LucideIcon;
  shortcut: string;
  run: () => void;
}

/**
 * The node menu (design system §5.1 shortcut table): Run from here and Rename. Arrows move, `Enter`
 * picks, `Esc` or a click outside closes. Each item names its keyboard shortcut.
 */
export function NodeActionsMenu({
  nodeId,
  at,
  onClose,
}: {
  nodeId: string;
  at: { x: number; y: number };
  onClose: () => void;
}) {
  const tokens = useMotionTokens();
  const ui = useUiStore();
  const runFrom = useRunFrom();
  const root = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const actions: Action[] = [
    ...(runFrom
      ? [{ id: "run-from", label: "Run from here", icon: Play, shortcut: "⌘↵", run: () => runFrom(nodeId) }]
      : []),
    { id: "rename", label: "Rename", icon: Pencil, shortcut: "F2", run: () => ui.getState().set({ renaming: nodeId }) },
  ];

  useEffect(() => {
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [onClose]);

  const pick = (a: Action) => {
    onClose();
    a.run();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = (active + (e.key === "ArrowDown" ? 1 : -1) + actions.length) % actions.length;
      setActive(next);
      root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[next]?.focus();
    }
  };

  return (
    <motion.div
      ref={root}
      role="menu"
      aria-label="Node actions"
      // Position comes from the button, so it cannot be a token; colour and spacing are tokens.
      style={{ left: at.x, top: at.y }}
      initial={{ opacity: 0, y: -tokens.travel }}
      animate={{ opacity: 1, y: 0, transition: enterTransition(tokens, "snappy") }}
      className="nodrag nowheel fixed z-50 flex w-picker flex-col rounded-md border border-hairline bg-surface p-2 shadow-pop"
      onKeyDown={onKeyDown}
    >
      {actions.map((a, i) => (
        <button
          key={a.id}
          type="button"
          role="menuitem"
          tabIndex={i === active ? 0 : -1}
          onMouseEnter={() => setActive(i)}
          onClick={() => pick(a)}
          className={`flex h-control items-center gap-4 rounded-sm px-3 text-body text-primary ${i === active ? "bg-accent-subtle" : ""}`}
        >
          <a.icon className="size-icon text-secondary" strokeWidth={1.75} aria-hidden="true" />
          <span className="flex-1 text-start">{a.label}</span>
          <Kbd>{a.shortcut}</Kbd>
        </button>
      ))}
    </motion.div>
  );
}
