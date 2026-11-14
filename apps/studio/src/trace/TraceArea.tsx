import type { Json, Span } from "@wakeel/contracts";
import { Badge, tabClasses, travel, useMotionTokens } from "@wakeel/ui";
import { useReactFlow } from "@xyflow/react";
import { Braces, ChevronDown, ChevronRight, CircleAlert, CircleCheck, CircleDot, type LucideIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { useCanvas, useCanvasStore } from "../canvas/context";
import { CARD_ICONS, CARD_NAMES, NODE_ICONS } from "../canvas/view/summaries";
import { useEmulator } from "../emulator/controller";
import { SizeMeter, VariablesBody } from "../emulator/VariablesTab";
import { formatDuration, stepLabel, stepRows } from "./model";

/** Indent per depth, from the space scale. */
const INDENT = ["ps-0", "ps-5", "ps-8", "ps-10", "ps-11"] as const;

/** While a turn runs, open steps' durations are redrawn this often so their bars grow (§5.3). */
const LIVE_TICK_MS = 100;

/**
 * The trace area under the emulator's transcript (design system §5.3): two tabs, Trace and
 * Variables. Trace lists the turn's steps as they start, with duration bars; clicking a step selects
 * its node or card on the canvas and shows the step's details.
 */
export function TraceArea() {
  const area = useEmulator((s) => s.area);
  const setArea = useEmulator((s) => s.setArea);
  const traceTurn = useEmulator((s) => s.traceTurn);
  const traces = useEmulator((s) => s.traces);
  const variables = useEmulator((s) => s.variables);
  const changed = useEmulator((s) => s.changed);
  const Chevron = area.open ? ChevronDown : ChevronRight;
  // Turns are numbered in the order their traces started.
  const turnNumber = useMemo(() => {
    const order = Object.entries(traces)
      .map(([id, spans]) => ({ id, at: spans.find((s) => s.kind === "turn")?.startedAt ?? "" }))
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((t) => t.id);
    return traceTurn ? order.indexOf(traceTurn) + 1 : 0;
  }, [traces, traceTurn]);

  const tab = (id: "trace" | "variables", label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={area.open && area.tab === id}
      onClick={() => setArea({ open: !(area.open && area.tab === id), tab: id })}
      className={`${tabClasses(area.open && area.tab === id)} h-control text-small`}
    >
      {label}
    </button>
  );

  return (
    <section aria-label="Trace and variables" className="flex max-h-1/2 shrink-0 flex-col border-t border-hairline">
      <div className="flex items-center gap-3 border-b border-hairline px-6">
        <button
          type="button"
          aria-label={area.open ? "Collapse" : "Expand"}
          aria-expanded={area.open}
          onClick={() => setArea({ open: !area.open })}
          className="flex size-control-sm items-center justify-center rounded-sm text-secondary hover:bg-subtle hover:text-primary"
        >
          <Chevron className="size-icon-sm" strokeWidth={1.75} aria-hidden="true" />
        </button>
        <div role="tablist" aria-label="Trace and variables" className="flex gap-5">
          {tab("trace", "Trace")}
          {tab("variables", "Variables")}
        </div>
        <span className="ms-auto flex items-center gap-2 text-micro text-secondary">
          {area.tab === "trace" && turnNumber > 0 ? <span className="tabular-nums">Turn {turnNumber}</span> : null}
          {area.tab === "variables" && changed.size > 0 ? <Badge tone="info">{changed.size} changed</Badge> : null}
          {area.tab === "variables" && variables ? (
            <SizeMeter used={variables.stateBytes} limit={variables.limitBytes} />
          ) : null}
        </span>
      </div>
      {area.open ? (
        <div className="min-h-0 overflow-y-auto px-6 py-4">
          {area.tab === "trace" ? <TraceList /> : <VariablesBody />}
        </div>
      ) : null}
    </section>
  );
}

function TraceList() {
  const traceTurn = useEmulator((s) => s.traceTurn);
  const spans = useEmulator((s) => (s.traceTurn ? s.traces[s.traceTurn] : undefined));
  const running = useEmulator((s) => s.transcript.running);
  const selected = useEmulator((s) => s.selectedStep);
  const selectStep = useEmulator((s) => s.selectStep);
  const botName = useCanvas((s) => s.manifest?.doc.name ?? "Bot");
  const canvas = useCanvasStore();
  const flow = useReactFlow();
  const tokens = useMotionTokens();
  const now = useNow(running);

  if (!traceTurn) return <p className="py-3 text-small text-secondary">Each turn's steps appear here as they run.</p>;
  if (!spans) return <p className="py-3 text-small text-secondary">Loading the trace…</p>;
  if (spans.length === 0)
    return <p className="py-3 text-small text-secondary">This turn's trace could not be loaded.</p>;

  const turn = spans.find((s) => s.kind === "turn");
  const open = (s: Span) => running && s.durationMs === 0 && (s.kind === "turn" || s.kind === "node");
  const shown = (s: Span) => (open(s) ? Math.max(0, now - new Date(s.startedAt).getTime()) : s.durationMs);
  const total = Math.max(1, turn ? shown(turn) : Math.max(...spans.map(shown)));
  const step = spans.find((s) => s.id === selected);

  const pick = (s: Span) => {
    selectStep(s.id);
    const { workflowId, nodeId, cardId } = s.location;
    if (!workflowId || !nodeId) return;
    const state = canvas.getState();
    if (state.activeWorkflowId !== workflowId) state.open(workflowId);
    canvas.getState().select({ nodeIds: [nodeId], edgeIds: [], card: cardId ? { nodeId, cardId } : undefined });
    // Bring the node into view (§5.1 "Fit view, jump to node": 240 ms; none with reduced motion).
    requestAnimationFrame(() => {
      const node = flow.getInternalNode(nodeId);
      if (!node) return;
      const { x, y } = node.internals.positionAbsolute;
      const { zoom } = flow.getViewport();
      void flow.setCenter(x + (node.measured.width ?? 0) / 2, y + (node.measured.height ?? 0) / 2, {
        zoom,
        duration: tokens.reduced ? 0 : tokens.duration.slower * 1000,
      });
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <ol aria-label="Steps" className="flex flex-col">
        <AnimatePresence initial={false}>
          {stepRows(spans).map(({ span, depth }) => {
            const Icon = iconOf(span);
            const ms = shown(span);
            const isOpen = open(span);
            return (
              <motion.li
                key={span.id}
                initial={{ opacity: 0, y: tokens.reduced ? 0 : -travel.min }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  y: tokens.spring.snappy,
                  opacity: {
                    duration: tokens.reduced ? tokens.duration.instant : tokens.duration.fast,
                    ease: tokens.ease.out,
                  },
                }}
              >
                <button
                  type="button"
                  aria-current={span.id === selected ? "step" : undefined}
                  onClick={() => pick(span)}
                  className={`flex h-row w-full items-center justify-between gap-3 rounded-xs px-2 text-start text-small hover:bg-subtle ${
                    span.id === selected ? "bg-accent-subtle" : ""
                  }`}
                >
                  <span className={`flex min-w-0 items-center gap-2 ${INDENT[Math.min(depth, INDENT.length - 1)]}`}>
                    <StatusIcon span={span} open={isOpen} Icon={Icon} />
                    <span
                      dir="auto"
                      className={`truncate ${span.kind === "turn" ? "font-medium text-primary" : "text-primary"}`}
                    >
                      {stepLabel(span, { botName, cardNames: CARD_NAMES })}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    {span.kind === "turn" ? null : (
                      <span aria-hidden="true" className="h-1 w-tile overflow-hidden rounded-full bg-muted">
                        {/* A data-driven width, not a design value. */}
                        <span
                          className={`block h-full rounded-full ${span.status === "error" ? "bg-error" : "bg-tertiary"}`}
                          style={{ width: `${Math.max(4, Math.round((ms / total) * 100))}%` }}
                        />
                      </span>
                    )}
                    <span className="w-tile text-end tabular-nums text-secondary">{formatDuration(ms)}</span>
                  </span>
                </button>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ol>
      {step ? <StepDetails span={step} /> : null}
    </div>
  );
}

/** The step's kind icon, or its outcome once it closes: the swap is an 80 ms cross-fade (§5.3). */
function StatusIcon({ span, open, Icon }: { span: Span; open: boolean; Icon: LucideIcon }) {
  const tokens = useMotionTokens();
  const key = span.status === "error" ? "error" : open ? "open" : "kind";
  const Shown = span.status === "error" ? CircleAlert : Icon;
  return (
    <span className="relative flex size-icon-sm shrink-0 items-center justify-center">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={key}
          className="flex"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: tokens.duration.instant, ease: tokens.ease.out }}
        >
          <Shown
            className={`size-icon-sm ${span.status === "error" ? "text-error" : open ? "text-tertiary" : "text-secondary"}`}
            strokeWidth={1.75}
            aria-label={span.status === "error" ? "Failed" : open ? "Running" : undefined}
            aria-hidden={span.status === "error" || open ? undefined : true}
          />
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

function iconOf(span: Span): LucideIcon {
  switch (span.kind) {
    case "turn":
      return CircleDot;
    case "node":
      return NODE_ICONS[span.attrs.nodeType as keyof typeof NODE_ICONS] ?? CircleDot;
    case "card":
      return CARD_ICONS[span.attrs.cardType as keyof typeof CARD_ICONS] ?? CircleDot;
    case "code.exec":
      return Braces;
    case "error":
      return CircleAlert;
    default:
      return CircleCheck;
  }
}

/** The selected step's details: what it changed, its code and logs, or its error. */
function StepDetails({ span }: { span: Span }) {
  // A card's writes are keyed by variable id; show each by its name.
  const manifest = useCanvas((s) => s.manifest?.doc);
  const workflows = useCanvas((s) => s.workflows);
  const names = useMemo(() => {
    const out: Record<string, string> = {};
    for (const v of manifest?.variables ?? []) out[v.id] = `${v.scope}.${v.name}`;
    for (const w of Object.values(workflows)) for (const v of w.doc.variables) out[v.id] = `workflow.${v.name}`;
    return out;
  }, [manifest, workflows]);
  const rows: [string, Json | string | undefined][] = [];
  switch (span.kind) {
    case "turn":
      rows.push(["Started by", span.attrs.trigger], ["Ended", span.attrs.outcome], ["Steps", span.attrs.stepCount]);
      break;
    case "node":
      rows.push(["Type", span.attrs.nodeType], ["Left by", span.attrs.leftBy]);
      break;
    case "card":
      rows.push(["Outcome", span.attrs.outcome]);
      for (const [id, w] of Object.entries(span.attrs.writes ?? {}))
        rows.push([id, `${show(w.before)} → ${show(w.after)}`]);
      break;
    case "code.exec":
      if (span.attrs.source?.inline) rows.push(["Code", span.attrs.source.value]);
      if (span.attrs.logs?.inline) rows.push(["Logs", span.attrs.logs.value]);
      break;
    case "error":
      rows.push(["Message", span.attrs.message], ["Fix", span.attrs.fix], ["Handled by", span.attrs.handledBy]);
      break;
    default:
      break;
  }
  const present = rows.filter((r) => r[1] !== undefined);
  return (
    <section aria-label="Step details" className="rounded-sm border border-hairline bg-subtle p-4">
      {present.length === 0 ? (
        <p className="text-small text-secondary">Nothing more was recorded for this step.</p>
      ) : (
        <dl className="flex flex-col gap-3">
          {present.map(([label, value]) => (
            <div key={label} className="flex flex-col gap-1">
              <dt className="text-micro text-secondary">{names[label] ?? label}</dt>
              <dd dir="auto" className="min-w-0 whitespace-pre-wrap break-words font-mono text-code-small text-primary">
                {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

const show = (v: Json) => (typeof v === "string" ? v : JSON.stringify(v));

/** The current time, ticking only while a turn runs (for open steps' growing bars). */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), LIVE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}
