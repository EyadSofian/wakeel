import { NON_TARGETABLE_NODE_TYPES, type NodeType } from "@wakeel/contracts";
import { Kbd } from "@wakeel/ui";
import { useCallback, useMemo } from "react";
import { useAddNode } from "../add-node";
import { useCanvas, useCanvasStore } from "../context";
import { NODE_ENTRIES } from "../library/NodeLibrary";
import { commands } from "../store/commands";
import { createMenuCard, type MenuCardType } from "../store/factories";
import { CARD_CATEGORY, CARD_ICONS, CARD_NAMES, NODE_CATEGORY, NODE_ICONS, NODE_TYPE_LABELS } from "../view/summaries";
import { NodeActionsMenu } from "./NodeActionsMenu";
import { type PickerItem, PickerMenu } from "./PickerMenu";
import { useUi, useUiStore } from "./ui-store";

/** The card menu's entries, grouped by what they are for (MVP card set). */
const CARD_ENTRIES: { type: MenuCardType; group: string; description: string }[] = [
  { type: "say", group: "Messages", description: "Sends a message: text, choices or media" },
  { type: "capture", group: "Messages", description: "Asks a question and saves the answer" },
  { type: "branch", group: "Logic", description: "Goes one way or another by a rule" },
  { type: "set_variable", group: "Logic", description: "Writes values to variables" },
  { type: "code", group: "Logic", description: "Runs JavaScript in the sandbox" },
  { type: "log", group: "Logic", description: "Writes a line to the trace" },
  { type: "end", group: "Logic", description: "Ends the conversation here" },
  { type: "kb_search", group: "Data", description: "Searches a knowledge base" },
  { type: "table", group: "Data", description: "Reads or writes rows of a table" },
  { type: "call_workflow", group: "Data", description: "Runs a sub-workflow and comes back" },
  { type: "handoff", group: "Human", description: "Passes the conversation to a person" },
];

/**
 * The add-node menu and the card menu, whichever is open (design system §5.1: double-click, `N`,
 * drag from an output into empty space, "+ Add card", `C`, `/`).
 */
export function CanvasMenus() {
  const menu = useUi((s) => s.menu);
  const connecting = useUi((s) => s.connecting !== undefined);
  const ui = useUiStore();
  const close = useCallback(() => ui.getState().set({ menu: undefined }), [ui]);
  if (connecting) return <ConnectHint />;
  if (!menu) return null;
  if (menu.kind === "actions") return <NodeActionsMenu nodeId={menu.nodeId} at={menu.at} onClose={close} />;
  return menu.kind === "node" ? (
    <NodeMenu at={menu.at} from={menu.from} onClose={close} />
  ) : (
    <CardMenu nodeId={menu.nodeId} at={menu.at} query={menu.query ?? ""} onClose={close} />
  );
}

function NodeMenu({
  at,
  from,
  onClose,
}: {
  at: { x: number; y: number };
  from: { nodeId: string; port: string } | undefined;
  onClose: () => void;
}) {
  const kind = useCanvas((s) => (s.activeWorkflowId ? s.workflows[s.activeWorkflowId]?.doc.kind : undefined));
  const addNode = useAddNode();
  const items = useMemo<PickerItem[]>(
    () =>
      NODE_ENTRIES.filter((e) => !e.kinds || (kind !== undefined && e.kinds.includes(kind)))
        // From an output, only nodes a transition can enter.
        .filter((e) => !from || !NON_TARGETABLE_NODE_TYPES.includes(e.type))
        .map((e) => ({
          id: e.type,
          label: NODE_TYPE_LABELS[e.type],
          description: e.description,
          group: e.group,
          icon: NODE_ICONS[e.type],
          category: NODE_CATEGORY[e.type],
        })),
    [kind, from],
  );
  return (
    <PickerMenu
      label="Add node"
      items={items}
      at={at}
      onClose={onClose}
      onPick={(type) => {
        addNode(type as NodeType, at, from);
        onClose();
      }}
    />
  );
}

function CardMenu({
  nodeId,
  at,
  query,
  onClose,
}: {
  nodeId: string;
  at: { x: number; y: number };
  query: string;
  onClose: () => void;
}) {
  const store = useCanvasStore();
  const ui = useUiStore();
  const wf = useCanvas((s) => (s.activeWorkflowId ? s.workflows[s.activeWorkflowId]?.doc : undefined));
  const workflows = useCanvas((s) => s.workflows);
  const all = useMemo(() => Object.values(workflows).map((w) => w.doc), [workflows]);

  const made = useMemo(
    () => new Map(wf ? CARD_ENTRIES.map((e) => [e.type, createMenuCard(e.type, wf, all)] as const) : []),
    [wf, all],
  );
  const items = useMemo<PickerItem[]>(
    () =>
      CARD_ENTRIES.map((e) => {
        const m = made.get(e.type);
        return {
          id: e.type,
          label: CARD_NAMES[e.type],
          description: e.description,
          group: e.group,
          icon: CARD_ICONS[e.type],
          category: CARD_CATEGORY[e.type],
          ...(m && "unavailable" in m ? { unavailable: m.unavailable } : {}),
        };
      }),
    [made],
  );

  const pick = (type: string) => {
    const m = made.get(type as MenuCardType);
    if (!m || "unavailable" in m || !wf) return;
    const command = m.variable
      ? commands.addCardWithVariable(nodeId, m.card, m.variable)
      : commands.addCard(nodeId, m.card);
    if (store.getState().execute(command).ok) {
      store.getState().select({ nodeIds: [nodeId], edgeIds: [], card: { nodeId, cardId: m.card.id } });
      ui.getState().set({ cursor: undefined });
    }
    onClose();
  };

  return <PickerMenu label="Add card" items={items} at={at} initialQuery={query} onClose={onClose} onPick={pick} />;
}

/** Keyboard connect mode says what the keys do, for people who can see it (the live region speaks it). */
function ConnectHint() {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-12 z-30 flex justify-center">
      <p className="flex items-center gap-4 rounded-md border border-hairline bg-surface px-6 py-4 text-body text-primary shadow-pop">
        Choose a node
        <span className="flex items-center gap-1 text-secondary">
          <Kbd>←</Kbd>
          <Kbd>→</Kbd>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
        </span>
        <span className="text-secondary">connect</span>
        <Kbd>Enter</Kbd>
        <span className="text-secondary">cancel</span>
        <Kbd>Esc</Kbd>
      </p>
    </div>
  );
}
