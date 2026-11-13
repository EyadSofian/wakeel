import { Panel, useReactFlow, useViewport } from "@xyflow/react";
import { Map as MapIcon, Maximize, Minus, Plus, Redo2, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import { useCanvas } from "../context";
import { FIT_VIEW } from "./viewport";

/** Canvas toolbar, bottom end (design system §4 CanvasToolbar): zoom, fit, undo, redo, minimap. */
function ToolButton({
  label,
  shortcut,
  onClick,
  disabled,
  pressed,
  children,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={[
        "flex size-control-sm items-center justify-center rounded-sm text-secondary transition-colors hover:bg-subtle hover:text-primary disabled:cursor-not-allowed disabled:opacity-50",
        pressed ? "bg-muted text-primary" : "",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

export function CanvasToolbar({ minimap, onToggleMinimap }: { minimap: boolean; onToggleMinimap: () => void }) {
  const flow = useReactFlow();
  const { zoom } = useViewport();
  const canUndo = useCanvas((s) =>
    s.activeWorkflowId ? (s.history[s.activeWorkflowId]?.past.length ?? 0) > 0 : false,
  );
  const canRedo = useCanvas((s) =>
    s.activeWorkflowId ? (s.history[s.activeWorkflowId]?.future.length ?? 0) > 0 : false,
  );
  const undo = useCanvas((s) => s.undo);
  const redo = useCanvas((s) => s.redo);
  const icon = "size-icon";
  return (
    <Panel position="bottom-right">
      <div
        role="toolbar"
        aria-label="Canvas"
        className="flex items-center gap-1 rounded-md border border-hairline bg-surface p-1 shadow-pop"
      >
        <ToolButton label="Zoom out" shortcut="⌘−" onClick={() => void flow.zoomOut()}>
          <Minus className={icon} strokeWidth={1.5} aria-hidden="true" />
        </ToolButton>
        <span className="w-12 text-center text-small text-secondary tabular-nums" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
        <ToolButton label="Zoom in" shortcut="⌘+" onClick={() => void flow.zoomIn()}>
          <Plus className={icon} strokeWidth={1.5} aria-hidden="true" />
        </ToolButton>
        <ToolButton label="Fit view" shortcut="⌘0" onClick={() => void flow.fitView(FIT_VIEW)}>
          <Maximize className={icon} strokeWidth={1.5} aria-hidden="true" />
        </ToolButton>
        <span aria-hidden="true" className="mx-1 h-5 border-s border-hairline" />
        <ToolButton label="Undo" shortcut="⌘Z" disabled={!canUndo} onClick={() => undo()}>
          <Undo2 className={icon} strokeWidth={1.5} aria-hidden="true" />
        </ToolButton>
        <ToolButton label="Redo" shortcut="⇧⌘Z" disabled={!canRedo} onClick={() => redo()}>
          <Redo2 className={icon} strokeWidth={1.5} aria-hidden="true" />
        </ToolButton>
        <ToolButton label="Minimap" shortcut="M" pressed={minimap} onClick={onToggleMinimap}>
          <MapIcon className={icon} strokeWidth={1.5} aria-hidden="true" />
        </ToolButton>
      </div>
    </Panel>
  );
}
