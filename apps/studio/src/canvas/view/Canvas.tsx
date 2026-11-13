import { NON_TARGETABLE_NODE_TYPES, type Workflow } from "@wakeel/contracts";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Connection,
  type EdgeTypes,
  MiniMap,
  type NodeChange,
  type NodeTypes,
  type OnSelectionChangeParams,
  ReactFlow,
  useReactFlow,
} from "@xyflow/react";
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCanvas, useCanvasStore } from "../context";
import type { groupIssues, NodeIssues } from "../issues";
import { type Command, commands } from "../store/commands";
import { createNode } from "../store/factories";
import { CanvasNode, type CanvasRFNode } from "./CanvasNode";
import { CanvasToolbar } from "./CanvasToolbar";
import type { SummaryContext } from "./summaries";
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
  const manifest = useCanvas((s) => s.manifest?.doc);
  const workflows = useCanvas((s) => s.workflows);
  const selection = useCanvas((s) => s.selection);
  const flow = useReactFlow();
  const [minimap, setMinimap] = useState(true);
  const [notice, setNotice] = useState("");
  const pointer = useRef<{ x: number; y: number } | null>(null);

  const summary = useMemo<SummaryContext>(
    () => ({
      variables: new Map([...(manifest?.variables ?? []), ...(wf?.variables ?? [])].map((v) => [v.id, v])),
      workflows: new Map(Object.values(workflows).map((w) => [w.doc.id, { name: w.doc.name }])),
    }),
    [manifest, wf, workflows],
  );

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

  const addNodeAt = useCallback(
    (screen: { x: number; y: number }) => {
      const p = flow.screenToFlowPosition(screen);
      run(commands.addNode(createNode("standard"), { x: Math.round(p.x / 8) * 8, y: Math.round(p.y / 8) * 8 }));
    },
    [flow, run],
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
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) store.getState().redo();
        else store.getState().undo();
      } else if (!mod && !e.altKey && e.key === "n") {
        const rect = region.current?.getBoundingClientRect();
        if (!rect) return;
        addNodeAt(pointer.current ?? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      } else if (!mod && !e.altKey && e.key === "m") {
        setMinimap((v) => !v);
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
        attributionPosition="bottom-left"
        aria-label={`${wf.name} workflow`}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} className="wk-grid" />
        {minimap ? <MiniMap pannable zoomable ariaLabel="Minimap" className="wk-minimap" nodeBorderRadius={8} /> : null}
        <CanvasToolbar minimap={minimap} onToggleMinimap={() => setMinimap((v) => !v)} />
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

const ORIGIN = { x: 0, y: 0 };

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
