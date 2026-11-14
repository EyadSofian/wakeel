import type {
  BotDefinition,
  BotDiff,
  DiffChange,
  DiffCounts,
  DiffPath,
  DiffSummary,
  FieldDiff,
  Json,
} from "@wakeel/contracts";
import { CARD_NAMES, NODE_TYPE_LABELS } from "../../canvas/view/summaries";

/** The Versions screens as pure data (task 7.5, design system §5.8). */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 added · 1 changed" for one kind; empty when nothing of that kind changed. */
function counts(c: DiffCounts): string {
  return [
    c.added ? `${c.added} added` : "",
    c.changed ? `${c.changed} changed` : "",
    c.removed ? `${c.removed} removed` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The publish dialog's summary of changes since the live version, one line per kind that changed
 * ("Workflows: 1 changed"). Empty when nothing changed.
 */
export function changeLines(summary: DiffSummary): { label: string; detail: string }[] {
  const rows: { label: string; detail: string }[] = [];
  const add = (label: string, c: DiffCounts) => {
    const d = counts(c);
    if (d) rows.push({ label, detail: d });
  };
  add("Workflows", summary.workflows);
  add("Nodes", summary.nodes);
  add("Cards", summary.cards);
  add("Transitions", summary.edges);
  if (summary.manifestFields > 0)
    rows.push({ label: "Bot settings", detail: `${plural(summary.manifestFields, "field")} changed` });
  return rows;
}

/** One line of the Compare view: a workflow, node or card heading, or a changed field under it. */
export interface DiffRow {
  key: string;
  depth: 0 | 1 | 2 | 3;
  kind: "workflow" | "node" | "card" | "field" | "transition" | "settings";
  change: DiffChange;
  /** The element's name (builder text: render with dir="auto"). */
  title: string;
  /** Its type, in design system §3.1 words. */
  detail?: string;
  before?: string;
  after?: string;
}

/** A field path as people read it: `message.text`, `branches[Order].when`. */
export function formatDiffPath(path: DiffPath): string {
  let out = "";
  for (const p of path) out += typeof p === "number" ? `[${p}]` : out === "" ? p : `.${p}`;
  return out || "value";
}

/** A value on one line, for the before and after columns. */
export function formatValue(v: Json | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function fieldRows(prefix: string, depth: DiffRow["depth"], fields: readonly FieldDiff[]): DiffRow[] {
  return fields.map((f, i) => {
    const before = formatValue(f.before);
    const after = formatValue(f.after);
    return {
      key: `${prefix}:f${i}`,
      depth,
      kind: "field" as const,
      change: before === undefined ? "added" : after === undefined ? "removed" : "changed",
      title: formatDiffPath(f.path),
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    };
  });
}

/**
 * The structural diff as rows, workflow → node → card → field (design system §5.8). Names come from
 * `after` for added and changed elements and from `before` for removed ones.
 */
export function diffRows(diff: BotDiff, before: BotDefinition, after: BotDefinition): DiffRow[] {
  const rows: DiffRow[] = [];
  if (diff.manifest.length > 0) {
    rows.push({ key: "manifest", depth: 0, kind: "settings", change: "changed", title: "Bot settings" });
    rows.push(...fieldRows("manifest", 1, diff.manifest));
  }
  const wfOf = (id: string, change: DiffChange) =>
    (change === "removed" ? before : after).workflows.find((w) => w.id === id) ??
    before.workflows.find((w) => w.id === id);
  for (const w of diff.workflows) {
    const wf = wfOf(w.workflowId, w.change);
    const nodeOf = (id: string, change: DiffChange) => {
      const from = change === "removed" ? before : after;
      return (
        from.workflows.find((x) => x.id === w.workflowId)?.nodes.find((n) => n.id === id) ??
        before.workflows.find((x) => x.id === w.workflowId)?.nodes.find((n) => n.id === id)
      );
    };
    rows.push({
      key: w.workflowId,
      depth: 0,
      kind: "workflow",
      change: w.change,
      title: wf?.name ?? w.workflowId,
      detail: "Workflow",
    });
    rows.push(...fieldRows(w.workflowId, 1, w.fields));
    for (const n of w.nodes) {
      const node = nodeOf(n.nodeId, n.change);
      rows.push({
        key: `${w.workflowId}:${n.nodeId}`,
        depth: 1,
        kind: "node",
        change: n.change,
        title: node?.name ?? n.nodeId,
        detail: NODE_TYPE_LABELS[n.nodeType as keyof typeof NODE_TYPE_LABELS] ?? n.nodeType,
      });
      rows.push(...fieldRows(`${w.workflowId}:${n.nodeId}`, 2, n.fields));
      for (const c of n.cards) {
        const name = CARD_NAMES[c.cardType as keyof typeof CARD_NAMES] ?? c.cardType;
        rows.push({
          key: `${w.workflowId}:${n.nodeId}:${c.cardId}`,
          depth: 2,
          kind: "card",
          change: c.change,
          title: name,
          ...(c.moved ? { detail: `Moved from position ${c.moved.from + 1} to ${c.moved.to + 1}` } : {}),
        });
        rows.push(...fieldRows(`${w.workflowId}:${n.nodeId}:${c.cardId}`, 3, c.fields));
      }
    }
    for (const e of w.edges) {
      const from = nodeOf(e.from.nodeId, e.change)?.name ?? e.from.nodeId;
      const target = (id: string | undefined) => (id ? (nodeOf(id, "changed")?.name ?? id) : undefined);
      const toBefore = target(e.toBefore);
      const toAfter = target(e.toAfter);
      rows.push({
        key: `${w.workflowId}:edge:${e.from.nodeId}:${e.from.port}`,
        depth: 1,
        kind: "transition",
        change: e.change,
        title: `${from} · ${e.from.port}`,
        ...(toBefore === undefined ? {} : { before: toBefore }),
        ...(toAfter === undefined ? {} : { after: toAfter }),
      });
    }
  }
  return rows;
}

/** Badge words for a change (design system §3 copy: sentence case). */
export const CHANGE_LABELS: Record<DiffChange, string> = { added: "Added", removed: "Removed", changed: "Changed" };
export const CHANGE_TONES: Record<DiffChange, "success" | "error" | "warning"> = {
  added: "success",
  removed: "error",
  changed: "warning",
};
