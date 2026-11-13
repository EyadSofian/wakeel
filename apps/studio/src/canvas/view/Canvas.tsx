import { NON_TARGETABLE_NODE_TYPES, type NodeType, type Workflow } from "@wakeel/contracts";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Connection,
  type EdgeTypes,
  MiniMap,
  type NodeChange,
  type NodeTypes,
  type OnConnectEnd,
  type OnSelectionChangeParams,
  ReactFlow,
  useReactFlow,
} from "@xyflow/react";
import { type DragEvent, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAddNode } from "../add-node";
import { useCanvas, useCanvasStore } from "../context";
import type { groupIssues, NodeIssues } from "../issues";
import { NODE_DRAG_TYPE } from "../library/NodeLibrary";
import { type Command, commands } from "../store/commands";
import { useSummaryContext } from "../use-summary";
import { CanvasNode, type CanvasRFNode } from "./CanvasNode";
import { type CanvasMode, CanvasToolbar } from "./CanvasToolbar";
import { NODE_CATEGORY, type SummaryContext } from "./summaries";
import { TransitionEdge, TransitionMarkers, type TransitionRFEdge } from "./TransitionEdge";
import { FIT_VIEW } from "./viewport";

const nodeTypes: NodeTypes = { wk: CanvasNode };
const edgeTypes: EdgeTypes = { transition: TransitionEdge };

/** Snap to 8 px (design system §2.3 canvas grid). */
const SNAP: [number, number] = [8, 8];

/**
 * The canvas (design system §5.1). xyflow draws and reports gestures; every change to the document
 * goes through a store command (CLAUDE.md §6). xyflow keeps its own copy of the nodes only for what
 * it measures and for positions while a drag is in progress.
 */
export function Canvas({ issues }: { issues: ReturnType<typeof groupIssues> }) {
  const store = useCanvasStore();
  const wf = useCanvas((s) => (s.activeWorkflowId ? s.workflows[s.activeWorkflowId]?.doc : undefined));
  const selection = useCanvas((s) => s.selection);
  const [minimap, setMinimap] = useState(true);
  // Hand pans on drag (the default); Select draws a selection box and pans with the middle button.
  const [mode, setMode] = useState<CanvasMode>("hand");
  const [notice, setNotice] = useState("");
  const pointer = useRef<{ x: number; y: number } | null>(null);

  const summary = useSummaryContext();

  // Node objects keep their identity while nothing about them changed, so a selection or an edit
  // re-renders the nodes it touched, not all 300 (design system §5.1 budget).
  const dataCache = useRef(new Map<string, CanvasRFNode["data"]>());
  const derived = useMemo(
    () => (wf ? toFlowNodes(wf, selection.nodeIds, summary, issues, dataCache.current) : []),
    [wf, selection.nodeIds, summary, issues],
  );
  const [nodes, setNodes] = useState<CanvasRFNode[]>(derived);
  // The document is the source of truth; keep only what xyflow measured.
  useEffect(() => {
    setNodes((prev) => {
      const before = new Map(prev.map((n) => [n.id, n]));
      return derived.map((n) => {
        const p = before.get(n.id);
        if (!p) return n;
        if (p.data === n.data && p.selected === n.selected && p.position === n.position) return p;
        return p.measured ? { ...n, measured: p.measured } : n;
      });
    });
  }, [derived]);

  // Transitions keep their identity too: clearing a selection should not rebuild 450 of them.
  const edgeCache = useRef(new Map<string, { source: Workflow["edges"][number]; rf: TransitionRFEdge }>());
  const edges = useMemo<TransitionRFEdge[]>(() => {
    const chosen = new Set(selection.edgeIds);
    return (wf?.edges ?? []).map((e) => {
      const selected = chosen.has(e.id);
      const prev = edgeCache.current.get(e.id);
      if (prev && prev.source === e && prev.rf.selected === selected) return prev.rf;
      const rf: TransitionRFEdge = {
        id: e.id,
        type: "transition",
        source: e.from.nodeId,
        sourceHandle: e.from.port,
        target: e.to.nodeId,
        targetHandle: "in",
        selected,
        reconnectable: true,
      };
      edgeCache.current.set(e.id, { source: e, rf });
      return rf;
    });
  }, [wf, selection.edgeIds]);

  const run = useCallback(
    (command: Command) => {
      const result = store.getState().execute(command);
      setNotice(result.ok ? "" : result.reason);
      return result.ok;
    },
    [store],
  );

  const onNodesChange = useCallback((changes: NodeChange<CanvasRFNode>[]) => {
    // Positions while dragging and measured sizes stay local; removals and selection go through
    // onNodesDelete and onSelectionChange.
    setNodes((n) =>
      applyNodeChanges(
        changes.filter((c) => c.type === "position" || c.type === "dimensions"),
        n,
      ),
    );
  }, []);

  const onNodeDragStop = useCallback(
    (_e: unknown, _node: CanvasRFNode, dragged: CanvasRFNode[]) => {
      run(
        commands.moveNodes(
          Object.fromEntries(dragged.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }])),
        ),
      );
    },
    [run],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (c.sourceHandle) run(commands.connect({ nodeId: c.source, port: c.sourceHandle }, c.target));
    },
    [run],
  );

  const onReconnect = useCallback(
    (old: TransitionRFEdge, c: Connection) => {
      if (old.source === c.source && old.sourceHandle === c.sourceHandle) run(commands.reconnect(old.id, c.target));
      else if (c.sourceHandle && run(commands.deleteEdges([old.id])))
        run(commands.connect({ nodeId: c.source, port: c.sourceHandle }, c.target));
    },
    [run],
  );

  // Dropping a transition anywhere on a node connects to it, not only on its input port (§5.1
  // "Connect: drag from an output to a node"). xyflow only reports drops near a handle.
  const flow = useReactFlow<CanvasRFNode, TransitionRFEdge>();
  // Hit-tested in canvas coordinates: while a transition is dragged, nodes do not receive pointer
  // events, so the element under the pointer is never the node.
  const nodeUnder = useCallback(
    (event: globalThis.MouseEvent | TouchEvent): string | undefined => {
      const screen = pointOf(event);
      if (!screen) return undefined;
      const p = flow.screenToFlowPosition(screen);
      const hit = flow
        .getNodes()
        .find(
          (n) =>
            n.measured?.width !== undefined &&
            n.measured.height !== undefined &&
            p.x >= n.position.x &&
            p.x <= n.position.x + n.measured.width &&
            p.y >= n.position.y &&
            p.y <= n.position.y + n.measured.height,
        );
      return hit?.id;
    },
    [flow],
  );
  const targetable = useCallback(
    (nodeId: string, from: string) => {
      const target = wf?.nodes.find((n) => n.id === nodeId);
      return target !== undefined && nodeId !== from && !NON_TARGETABLE_NODE_TYPES.includes(target.type);
    },
    [wf],
  );
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, state) => {
      if (state.isValid === true || !state.fromNode || state.fromHandle?.type !== "source" || !state.fromHandle.id)
        return;
      const to = nodeUnder(event);
      if (to && targetable(to, state.fromNode.id))
        run(commands.connect({ nodeId: state.fromNode.id, port: state.fromHandle.id }, to));
    },
    [run, targetable, nodeUnder],
  );
  const onReconnectEnd = useCallback(
    (
      event: globalThis.MouseEvent | TouchEvent,
      old: TransitionRFEdge,
      _type: unknown,
      state: { isValid: boolean | null },
    ) => {
      if (state.isValid === true) return;
      const to = nodeUnder(event);
      if (to && to !== old.target && targetable(to, old.source)) run(commands.reconnect(old.id, to));
    },
    [run, targetable, nodeUnder],
  );

  const isValidConnection = useCallback(
    (c: Connection | TransitionRFEdge) => {
      const target = wf?.nodes.find((n) => n.id === c.target);
      return target !== undefined && !NON_TARGETABLE_NODE_TYPES.includes(target.type);
    },
    [wf],
  );

  const onSelectionChange = useCallback(
    ({ nodes: n, edges: e }: OnSelectionChangeParams) => {
      const s = store.getState().selection;
      const nodeIds = n.map((x) => x.id);
      const edgeIds = e.map((x) => x.id);
      if (nodeIds.join() !== s.nodeIds.join() || edgeIds.join() !== s.edgeIds.join()) {
        store.getState().select({ nodeIds, edgeIds });
      }
    },
    [store],
  );

  const addNode = useAddNode();
  const addNodeAt = useCallback(
    (screen: { x: number; y: number }, type: NodeType = "standard") => {
      const result = addNode(type, screen);
      setNotice(result.ok ? "" : result.reason);
    },
    [addNode],
  );

  // Dropping a node from the library adds it where it lands.
  const onDragOver = useCallback((e: DragEvent) => {
    if (e.dataTransfer.types.includes(NODE_DRAG_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);
  const onDrop = useCallback(
    (e: DragEvent) => {
      const type = e.dataTransfer.getData(NODE_DRAG_TYPE) as NodeType;
      if (!type) return;
      e.preventDefault();
      addNodeAt({ x: e.clientX, y: e.clientY }, type);
    },
    [addNodeAt],
  );

  // Double-click on empty canvas adds a node there (§5.1). The add-node menu arrives in 2.5.
  const onDoubleClick = useCallback(
    (e: MouseEvent) => {
      if ((e.target as HTMLElement).classList.contains("react-flow__pane")) addNodeAt({ x: e.clientX, y: e.clientY });
    },
    [addNodeAt],
  );

  // Keyboard: undo, redo, add node at pointer or centre, toggle minimap. The full table is 2.5.
  // Listens on the document because clicking the empty pane leaves focus on <body>; it acts only
  // when focus is on the canvas or on nothing, never inside a field, a dialog or another panel.
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const onCanvas = !active || active === document.body || region.current?.contains(active);
      if (!onCanvas || e.defaultPrevented) return;
      if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable], [role=dialog]")) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        store.getState().clearSelection();
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) store.getState().redo();
        else store.getState().undo();
      } else if (!mod && !e.altKey && e.key === "n") {
        const rect = region.current?.getBoundingClientRect();
        if (!rect) return;
        addNodeAt(pointer.current ?? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      } else if (!mod && !e.altKey && e.key === "m") {
        setMinimap((v) => !v);
      } else if (!mod && !e.altKey && e.key === "v") {
        setMode("select");
      } else if (!mod && !e.altKey && e.key === "h") {
        setMode("hand");
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [addNodeAt, store]);

  if (!wf) return null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: double-click on empty canvas adds a node; xyflow inside is focusable.
    <div
      ref={region}
      className="wk-canvas relative h-full w-full"
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDoubleClick={onDoubleClick}
      onMouseMove={(e) => {
        pointer.current = { x: e.clientX, y: e.clientY };
      }}
    >
      <TransitionMarkers />
      <ReactFlow<CanvasRFNode, TransitionRFEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onDelete={({ nodes: n, edges: e }) =>
          run(
            commands.deleteSelection(
              n.map((x) => x.id),
              e.map((x) => x.id),
            ),
          )
        }
        onConnect={onConnect}
        onReconnect={onReconnect}
        onConnectEnd={onConnectEnd}
        onReconnectEnd={onReconnectEnd}
        isValidConnection={isValidConnection}
        onSelectionChange={onSelectionChange}
        deleteKeyCode={["Backspace", "Delete"]}
        multiSelectionKeyCode="Shift"
        zoomOnDoubleClick={false}
        snapToGrid
        snapGrid={SNAP}
        minZoom={0.1}
        maxZoom={2}
        onlyRenderVisibleElements
        fitView
        fitViewOptions={FIT_VIEW}
        attributionPosition="bottom-center"
        panOnDrag={mode === "hand" ? true : PAN_BUTTONS}
        selectionOnDrag={mode === "select"}
        aria-label={`${wf.name} workflow`}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} className="wk-grid" />
        {minimap ? (
          <MiniMap
            pannable
            zoomable
            ariaLabel="Minimap"
            className="wk-minimap"
            nodeBorderRadius={8}
            nodeClassName={minimapNodeClass}
          />
        ) : null}
        <CanvasToolbar minimap={minimap} onToggleMinimap={() => setMinimap((v) => !v)} mode={mode} onMode={setMode} />
      </ReactFlow>
      <p role="status" aria-live="polite" className="sr-only">
        {notice}
      </p>
      {notice ? (
        <div className="pointer-events-none absolute inset-x-0 top-6 flex justify-center">
          <p className="rounded-md border border-hairline bg-surface px-5 py-3 text-body text-primary shadow-pop">
            {notice}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** Screen point of a mouse or touch end event. */
function pointOf(event: globalThis.MouseEvent | TouchEvent): { x: number; y: number } | undefined {
  const p = "changedTouches" in event ? event.changedTouches[0] : event;
  return p ? { x: p.clientX, y: p.clientY } : undefined;
}

const ORIGIN = { x: 0, y: 0 };

/** Minimap blocks take their node's category colour (ADR-017). */
const minimapNodeClass = (n: CanvasRFNode) => `wk-mm-${NODE_CATEGORY[n.data.node.type]}`;
/** In Select mode the middle and right buttons still pan. */
const PAN_BUTTONS = [1, 2];

/** Same severity and message for the node and each card: the drawing would not change. */
function sameIssues(a: NodeIssues | undefined, b: NodeIssues | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.node?.severity !== b.node?.severity || a.node?.message !== b.node?.message) return false;
  if (a.cards.size !== b.cards.size) return false;
  for (const [id, x] of a.cards) {
    const y = b.cards.get(id);
    if (!y || y.severity !== x.severity || y.message !== x.message) return false;
  }
  return true;
}

function toFlowNodes(
  wf: Workflow,
  selected: readonly string[],
  summary: SummaryContext,
  issues: ReadonlyMap<string, NodeIssues>,
  cache: Map<string, CanvasRFNode["data"]>,
): CanvasRFNode[] {
  const chosen = new Set(selected);
  return wf.nodes.map((node) => {
    const prev = cache.get(node.id);
    const nodeIssues = issues.get(node.id);
    const data =
      prev && prev.node === node && prev.summary === summary && sameIssues(prev.issues, nodeIssues)
        ? prev
        : { node, summary, issues: nodeIssues };
    cache.set(node.id, data);
    return {
      id: node.id,
      type: "wk",
      position: wf.layout[node.id] ?? ORIGIN,
      data,
      selected: chosen.has(node.id),
      // The one entry point of a workflow cannot be deleted from the canvas.
      deletable: node.type !== "start" && node.type !== "entry",
    };
  });
}
