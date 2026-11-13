/**
 * Canvas shortcuts (design system §5.1 interaction table), shown by the shortcut sheet (`?`) and
 * in tooltips. The keyboard handler in `use-canvas-keyboard.ts` implements every row here; a test
 * checks the two agree. Rows the table lists that arrive with later tasks are not here:
 * Run from here (`⌘Enter`, emulator 4.6), Command palette (`⌘K`, 2.8), Search in bot (`⌘F`, 2.8).
 */
export interface Shortcut {
  id: string;
  keys: string[];
  action: string;
  group: "Canvas" | "Nodes" | "Cards" | "Transitions";
}

export const SHORTCUTS: readonly Shortcut[] = [
  { id: "pan", group: "Canvas", keys: ["←", "→", "↑", "↓"], action: "Pan, with nothing selected" },
  { id: "zoom-in", group: "Canvas", keys: ["⌘", "+"], action: "Zoom in" },
  { id: "zoom-out", group: "Canvas", keys: ["⌘", "−"], action: "Zoom out" },
  { id: "fit", group: "Canvas", keys: ["⌘", "0"], action: "Fit the workflow" },
  { id: "zoom-100", group: "Canvas", keys: ["⌘", "1"], action: "Zoom to 100%" },
  { id: "tool-select", group: "Canvas", keys: ["V"], action: "Select tool" },
  { id: "tool-pan", group: "Canvas", keys: ["H"], action: "Pan tool" },
  { id: "minimap", group: "Canvas", keys: ["M"], action: "Show or hide the minimap" },
  { id: "tidy", group: "Canvas", keys: ["⇧", "⌘", "L"], action: "Tidy layout" },
  { id: "undo", group: "Canvas", keys: ["⌘", "Z"], action: "Undo" },
  { id: "redo", group: "Canvas", keys: ["⇧", "⌘", "Z"], action: "Redo" },
  { id: "sheet", group: "Canvas", keys: ["?"], action: "Show these shortcuts" },

  { id: "add-node", group: "Nodes", keys: ["N"], action: "Add node at the pointer" },
  { id: "next-node", group: "Nodes", keys: ["Tab"], action: "Select the next node; ⇧Tab the previous" },
  { id: "nearest", group: "Nodes", keys: ["←", "→", "↑", "↓"], action: "Select the nearest node that way" },
  { id: "enter", group: "Nodes", keys: ["Enter"], action: "Go into the node to its cards and outputs" },
  { id: "leave", group: "Nodes", keys: ["Esc"], action: "Go up one level; clears the selection at the top" },
  { id: "move", group: "Nodes", keys: ["⇧", "←→↑↓"], action: "Move 8 px; with ⌥, 1 px" },
  { id: "rename", group: "Nodes", keys: ["F2"], action: "Rename; double-click the name works too" },
  { id: "duplicate", group: "Nodes", keys: ["⌘", "D"], action: "Duplicate" },
  { id: "delete", group: "Nodes", keys: ["⌫"], action: "Delete" },
  { id: "copy", group: "Nodes", keys: ["⌘", "C"], action: "Copy" },
  { id: "paste", group: "Nodes", keys: ["⌘", "V"], action: "Paste at the pointer, in any workflow or bot" },

  { id: "add-card", group: "Cards", keys: ["C"], action: "Add card to the selected node" },
  { id: "card-search", group: "Cards", keys: ["/"], action: "Add card, typing to filter" },
  { id: "row", group: "Cards", keys: ["↑", "↓"], action: "Previous or next card or output, inside a node" },
  { id: "reorder", group: "Cards", keys: ["⌥", "↑↓"], action: "Move the card up or down" },
  { id: "delete-card", group: "Cards", keys: ["⌫"], action: "Delete the card, inside a node" },

  { id: "connect", group: "Transitions", keys: ["Enter"], action: "On an output: choose a node to connect to" },
  { id: "choose", group: "Transitions", keys: ["←", "→", "↑", "↓"], action: "Choose the target node" },
  { id: "confirm", group: "Transitions", keys: ["Enter"], action: "Connect; Esc cancels" },
  { id: "reconnect", group: "Transitions", keys: ["R"], action: "Point the selected transition at another node" },
];
