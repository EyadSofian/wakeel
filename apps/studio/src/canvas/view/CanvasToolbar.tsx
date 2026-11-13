import { Panel, useReactFlow, useViewport } from "@xyflow/react";
import { Hand, Map as MapIcon, Maximize, Minus, MousePointer2, Plus, Redo2, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import { useCanvas } from "../context";
import { FIT_VIEW } from "./viewport";

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
        pressed ? "bg-accent-subtle text-accent-text hover:bg-accent-subtle hover:text-accent-text" : "",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

export type CanvasMode = "hand" | "select";

/**
 * Canvas toolbars (design system §4 CanvasToolbar, ADR-017): tools, history, fit and minimap float
 * at the top centre; zoom sits at the bottom start.
 */
export function CanvasToolbar({
  minimap,
  onToggleMinimap,
  mode,
  onMode,
}: {
  minimap: boolean;
  onToggleMinimap: () => void;
  mode: CanvasMode;
  onMode: (mode: CanvasMode) => void;
}) {
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
  const bar = "flex items-center gap-1 rounded-md border border-hairline bg-surface p-2 shadow-pop";
  const divider = <span aria-hidden="true" className="mx-2 h-6 border-s border-hairline" />;
  return (
    <>
      <Panel position="top-center">
        <div role="toolbar" aria-label="Canvas" className={bar}>
          <ToolButton label="Select" shortcut="V" pressed={mode === "select"} onClick={() => onMode("select")}>
            <MousePointer2 className={icon} strokeWidth={1.75} aria-hidden="true" />
          </ToolButton>
          <ToolButton label="Pan" shortcut="H" pressed={mode === "hand"} onClick={() => onMode("hand")}>
            <Hand className={icon} strokeWidth={1.75} aria-hidden="true" />
          </ToolButton>
          {divider}
          <ToolButton label="Undo" shortcut="⌘Z" disabled={!canUndo} onClick={() => undo()}>
            <Undo2 className={icon} strokeWidth={1.75} aria-hidden="true" />
          </ToolButton>
          <ToolButton label="Redo" shortcut="⇧⌘Z" disabled={!canRedo} onClick={() => redo()}>
            <Redo2 className={icon} strokeWidth={1.75} aria-hidden="true" />
          </ToolButton>
          {divider}
          <ToolButton label="Fit view" shortcut="⌘0" onClick={() => void flow.fitView(FIT_VIEW)}>
            <Maximize className={icon} strokeWidth={1.75} aria-hidden="true" />
          </ToolButton>
          <ToolButton label="Minimap" shortcut="M" pressed={minimap} onClick={onToggleMinimap}>
            <MapIcon className={icon} strokeWidth={1.75} aria-hidden="true" />
          </ToolButton>
        </div>
      </Panel>
      <Panel position="bottom-left">
        <div role="toolbar" aria-label="Zoom" className={bar}>
          <ToolButton label="Zoom out" shortcut="⌘−" onClick={() => void flow.zoomOut()}>
            <Minus className={icon} strokeWidth={1.75} aria-hidden="true" />
          </ToolButton>
          <span className="w-11 text-center text-small text-secondary tabular-nums" aria-live="polite">
            {Math.round(zoom * 100)}%
          </span>
          <ToolButton label="Zoom in" shortcut="⌘+" onClick={() => void flow.zoomIn()}>
            <Plus className={icon} strokeWidth={1.75} aria-hidden="true" />
          </ToolButton>
        </div>
      </Panel>
    </>
  );
}
