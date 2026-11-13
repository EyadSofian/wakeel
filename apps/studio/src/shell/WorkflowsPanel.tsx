import type { Workflow } from "@wakeel/contracts";
import { Button, enterTransition, useMotionTokens } from "@wakeel/ui";
import { Copy, Ellipsis, PencilLine, Plus, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { useCanvas } from "../canvas/context";
import { orderWorkflows } from "../routes/variables/model";
import { useShell } from "./shell-store";
import { useGoTo } from "./use-go-to";
import { useWorkflowRequests } from "./WorkflowDialogs";
import { deleteBlocker, duplicateBlocker } from "./workflows";

/**
 * The Workflows tab of the resource panel (design system §5.1, task 2.8): every workflow of the
 * bot, Main first. Click opens one on the canvas; each row's menu renames, duplicates or deletes
 * it. "New workflow" creates a sub-workflow. Main and the error workflow say why they cannot be
 * deleted or duplicated instead of hiding the choice.
 */
export function WorkflowsPanel() {
  const { store } = useShell();
  const workflows = useCanvas((s) => s.workflows);
  const active = useCanvas((s) => s.activeWorkflowId);
  const list = useMemo(() => orderWorkflows(Object.values(workflows).map((w) => w.doc)), [workflows]);
  const go = useGoTo();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-5">
      <Button
        icon={<Plus className="size-icon" strokeWidth={1.75} aria-hidden="true" />}
        onClick={() => store.getState().set({ dialog: { kind: "new" } })}
      >
        New workflow
      </Button>
      <ul aria-label="Workflows" className="flex flex-col gap-1">
        {list.map((wf) => (
          <Row key={wf.id} wf={wf} active={wf.id === active} onOpen={() => go.place({ workflowId: wf.id })} />
        ))}
      </ul>
      {list.length === 1 ? (
        <p className="px-2 text-small text-tertiary">
          Split a long flow into sub-workflows, then call them from a Run workflow card or an autonomous node.
        </p>
      ) : null}
    </div>
  );
}

const KIND_LABEL: Record<Workflow["kind"], string | undefined> = { main: "Main", error: "Errors", sub: undefined };

function Row({ wf, active, onOpen }: { wf: Workflow; active: boolean; onOpen: () => void }) {
  const { store } = useShell();
  const [menu, setMenu] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  // "Main" next to a workflow named Main says nothing; the label shows only when the name differs.
  const label = KIND_LABEL[wf.kind];
  const kind = label && label.toLowerCase() !== wf.name.trim().toLowerCase() ? label : undefined;
  return (
    <li className="group relative">
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "F2") {
            e.preventDefault();
            store.getState().set({ dialog: { kind: "rename", workflowId: wf.id } });
          }
        }}
        className={[
          "flex h-row w-full items-center gap-4 rounded-sm pe-10 ps-4 text-body transition-colors",
          active ? "bg-accent-subtle text-accent-text" : "text-primary hover:bg-subtle",
        ].join(" ")}
      >
        {/* bdi, not dir="auto": an Arabic name keeps its own direction but stays at the start edge. */}
        <span className="min-w-0 flex-1 truncate text-start font-medium">
          <bdi>{wf.name}</bdi>
        </span>
        {kind ? <span className="shrink-0 text-small text-tertiary">{kind}</span> : null}
        <span className="shrink-0 text-small text-tertiary tabular-nums" title="Nodes">
          {wf.nodes.length}
        </span>
      </button>
      <button
        ref={trigger}
        type="button"
        aria-label={`More for ${wf.name}`}
        title="Rename, duplicate or delete"
        aria-haspopup="menu"
        aria-expanded={menu}
        aria-controls={menu ? menuId : undefined}
        onClick={() => setMenu((m) => !m)}
        className={[
          "absolute end-1 top-1/2 flex size-tile-sm -translate-y-1/2 items-center justify-center rounded-xs text-secondary transition-opacity hover:bg-muted hover:text-primary focus-visible:opacity-100",
          menu || active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        ].join(" ")}
      >
        <Ellipsis className="size-icon" strokeWidth={1.75} aria-hidden="true" />
      </button>
      {menu ? (
        <RowMenu
          id={menuId}
          wf={wf}
          onClose={(refocus) => {
            setMenu(false);
            if (refocus) trigger.current?.focus();
          }}
        />
      ) : null}
    </li>
  );
}

interface MenuItem {
  id: string;
  label: string;
  icon: typeof Copy;
  danger?: boolean;
  unavailable?: string;
  run(): void;
}

/** The row's menu: Rename, Duplicate, Delete workflow. Arrows move, `Enter` picks, `Esc` closes. */
function RowMenu({ id, wf, onClose }: { id: string; wf: Workflow; onClose: (refocus: boolean) => void }) {
  const { store } = useShell();
  const requests = useWorkflowRequests();
  const tokens = useMotionTokens();
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const items: MenuItem[] = [
    {
      id: "rename",
      label: "Rename",
      icon: PencilLine,
      run: () => store.getState().set({ dialog: { kind: "rename", workflowId: wf.id } }),
    },
    {
      id: "duplicate",
      label: "Duplicate",
      icon: Copy,
      ...(duplicateBlocker(wf) ? { unavailable: duplicateBlocker(wf) } : {}),
      run: () =>
        void requests.duplicate(wf).then((error) => {
          if (error)
            store.getState().set({ dialog: { kind: "failed", title: "The workflow was not duplicated", error } });
        }),
    },
    {
      id: "delete",
      label: "Delete workflow",
      icon: Trash2,
      danger: true,
      ...(deleteBlocker(wf) ? { unavailable: deleteBlocker(wf) } : {}),
      run: () => store.getState().set({ dialog: { kind: "delete", workflowId: wf.id } }),
    },
  ];

  useEffect(() => {
    root.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled])')?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!root.current?.contains(t) && !t.closest('[aria-haspopup="menu"]')) close.current(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    const all = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled])') ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      all[(at + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    }
  };

  return (
    <motion.div
      ref={root}
      id={id}
      role="menu"
      aria-label={`${wf.name} workflow`}
      initial={{ opacity: 0, y: -tokens.travel }}
      animate={{ opacity: 1, y: 0, transition: enterTransition(tokens, "snappy") }}
      onKeyDown={onKeyDown}
      className="absolute inset-x-0 top-full z-30 mt-1 flex flex-col rounded-md border border-hairline bg-surface p-2 shadow-pop"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          {...(item.unavailable ? { "aria-disabled": true } : {})}
          onClick={() => {
            if (item.unavailable) return;
            onClose(false);
            item.run();
          }}
          className={[
            "flex items-start gap-4 rounded-sm px-4 py-2 text-start transition-colors",
            item.unavailable ? "cursor-not-allowed" : "hover:bg-subtle focus-visible:bg-subtle",
          ].join(" ")}
        >
          <item.icon
            className={`mt-1 size-icon shrink-0 ${item.unavailable ? "text-tertiary" : item.danger ? "text-error" : "text-secondary"}`}
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <span className="flex min-w-0 flex-col">
            <span
              className={`text-body ${item.unavailable ? "text-tertiary" : item.danger ? "text-error" : "text-primary"}`}
            >
              {item.label}
            </span>
            {item.unavailable ? <span className="text-small text-tertiary">{item.unavailable}</span> : null}
          </span>
        </button>
      ))}
    </motion.div>
  );
}
