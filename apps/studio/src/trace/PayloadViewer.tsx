import { Json, type Payload, type Span } from "@wakeel/contracts";
import { Button, tabClasses } from "@wakeel/ui";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { ProblemBanner } from "../shell/ProblemBanner";
import { formatCost, formatDuration, tokensOf } from "./model";

/**
 * PayloadViewer (design system §4 "Trace", task 6.9): what a step sent and got back, in up to four
 * tabs — Prompt, Code, Input, Output — with JSON as a tree, code and text as they were, and the model
 * call's tokens and cost. Every string is model-, bot- or user-written, so it renders with
 * `dir="auto"` and never as HTML.
 */

type TabId = "prompt" | "code" | "input" | "output";
const TAB_LABELS: Record<TabId, string> = { prompt: "Prompt", code: "Code", input: "Input", output: "Output" };

/** The payloads a step has, by tab; an iteration shows its model call's prompt. */
export function payloadTabs(span: Span, spans: readonly Span[]): Partial<Record<TabId, Payload>> {
  switch (span.kind) {
    case "autonomy.iteration": {
      const call = spans.find((s) => s.parentId === span.id && s.kind === "llm.call");
      const prompt = call?.kind === "llm.call" ? call.attrs.prompt : undefined;
      return {
        ...(prompt ? { prompt } : {}),
        ...(span.attrs.code ? { code: span.attrs.code } : {}),
        ...(span.attrs.result
          ? { output: span.attrs.result }
          : span.attrs.response
            ? { output: span.attrs.response }
            : {}),
      };
    }
    case "llm.call":
      return {
        ...(span.attrs.prompt ? { prompt: span.attrs.prompt } : {}),
        ...(span.attrs.completion ? { output: span.attrs.completion } : {}),
      };
    case "tool.call":
      return {
        ...(span.attrs.input ? { input: span.attrs.input } : {}),
        ...(span.attrs.output ? { output: span.attrs.output } : {}),
      };
    case "code.exec":
      return {
        ...(span.attrs.source ? { code: span.attrs.source } : {}),
        ...(span.attrs.logs ? { output: span.attrs.logs } : {}),
      };
    default:
      return {};
  }
}

export function PayloadViewer({ span, spans }: { span: Span; spans: readonly Span[] }) {
  const tabs = useMemo(() => payloadTabs(span, spans), [span, spans]);
  const ids = (Object.keys(TAB_LABELS) as TabId[]).filter((t) => tabs[t]);
  const [tab, setTab] = useState<TabId | undefined>(ids[0]);
  // A different step opens on its own first tab.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the step is the trigger.
  useEffect(() => setTab(ids[0]), [span.id]);
  const current = tab && tabs[tab] ? tab : ids[0];
  const payload = current ? tabs[current] : undefined;
  const owner =
    span.kind === "autonomy.iteration" && current === "prompt"
      ? (spans.find((entry) => entry.parentId === span.id && entry.kind === "llm.call") ?? span)
      : span;

  return (
    <section aria-label="Step details" className="flex flex-col gap-3 rounded-sm border border-hairline bg-subtle p-4">
      <Summary span={span} spans={spans} />
      {ids.length === 0 ? (
        <p className="text-small text-secondary">Nothing more was recorded for this step.</p>
      ) : (
        <>
          <div role="tablist" aria-label="Payload" className="flex gap-5 border-b border-hairline">
            {ids.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={current === id}
                onClick={() => setTab(id)}
                className={`${tabClasses(current === id)} h-control-sm text-small`}
              >
                {TAB_LABELS[id]}
              </button>
            ))}
          </div>
          <div role="tabpanel" aria-label={current ? TAB_LABELS[current] : undefined} className="min-w-0">
            {payload ? (
              <PayloadBody key={`${owner.id}:${current}`} payload={payload} code={current === "code"} span={owner} />
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

/** One line of facts: what the step was, how long it took, and for a model call its cost. */
function Summary({ span, spans }: { span: Span; spans: readonly Span[] }) {
  const facts: string[] = [formatDuration(span.durationMs)];
  if (span.kind === "llm.call") {
    facts.unshift(span.attrs.model || "Model");
    facts.push(`${tokensOf(span).toLocaleString("en-US")} tokens`, formatCost(span.attrs.usage.costMicroUsd));
    if (span.attrs.finishReason && span.attrs.finishReason !== "stop")
      facts.push(`stopped: ${span.attrs.finishReason}`);
  }
  if (span.kind === "autonomy.iteration") {
    facts.unshift(ITERATION_STATUS[span.attrs.status] + (span.attrs.exit ? ` "${span.attrs.exit}"` : ""));
    const call = spans.find((s) => s.parentId === span.id && s.kind === "llm.call");
    if (call) facts.push(`${tokensOf(call).toLocaleString("en-US")} tokens`);
  }
  if (span.kind === "tool.call") {
    facts.unshift(TOOL_TYPES[span.attrs.toolType]);
    if (span.attrs.sideEffects) facts.push("changes things outside the conversation");
    if (span.status === "error") facts.push("failed");
  }
  return <p className="text-small tabular-nums text-secondary">{facts.join(" · ")}</p>;
}

const ITERATION_STATUS: Record<Extract<Span, { kind: "autonomy.iteration" }>["attrs"]["status"], string> = {
  exit: "Left through",
  run_result: "Ran code and continued",
  run_error: "Code failed",
  protocol_error: "Reply did not follow the protocol",
  exit_invalid: "Chose an exit with invalid data",
  suspended: "Waiting on a tool",
  recovered: "Reply without directives, sent as text",
};

const TOOL_TYPES: Record<Extract<Span, { kind: "tool.call" }>["attrs"]["toolType"], string> = {
  code: "Code tool",
  kb_search: "Knowledge search",
  table: "Table tool",
  workflow: "Workflow tool",
  fetch: "Request",
  builtin: "Built-in",
};

function PayloadBody({ payload, code, span }: { payload: Payload; code: boolean; span: Span }) {
  const [loaded, setLoaded] = useState<{ value: Json }>();
  const [failure, setFailure] = useState<unknown>();
  const [pending, setPending] = useState(false);
  if (!payload.inline && !loaded)
    return (
      <div className="flex flex-col gap-2">
        <p className="text-micro text-secondary">
          {payload.key
            ? `Preview of ${Math.ceil(payload.bytes / 1024)} KB`
            : `Only the first 400 characters were kept (${Math.ceil(payload.bytes / 1024)} KB in all).`}
        </p>
        <Text value={payload.preview} />
        {failure != null && <ProblemBanner error={failure} />}
        {payload.key && (
          <Button
            disabled={pending}
            onClick={async () => {
              setPending(true);
              setFailure(undefined);
              try {
                const data = await api<{ value: unknown }>(
                  "GET",
                  `/v1/workspaces/${span.workspaceId}/turns/${span.turnId}/trace/${span.id}/payload/${encodeURIComponent(payload.key)}`,
                );
                setLoaded({ value: Json.parse(data.value) });
              } catch (error) {
                setFailure(error);
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? "Loading payload" : "Load full payload"}
          </Button>
        )}
      </div>
    );
  const value = payload.inline ? payload.value : (loaded?.value ?? null);
  if (typeof value === "string") return code ? <Code value={value} /> : <Text value={value} />;
  if (isPrompt(value)) return <Prompt value={value} />;
  return <JsonTree value={value} />;
}

function isPrompt(value: Json): value is { system: string; messages: { role: string; content: string }[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, Json>;
  return typeof v["system"] === "string" && Array.isArray(v["messages"]);
}

/** The prompt as the model read it: the system text, then each message with its role. */
function Prompt({ value }: { value: { system: string; messages: { role: string; content: string }[] } }) {
  return (
    <ol className="flex flex-col gap-3">
      {[{ role: "system", content: value.system }, ...value.messages].map((m, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: messages have no id and never reorder.
        <li key={i} className="flex flex-col gap-1">
          <span className="text-micro text-secondary">{ROLE_LABELS[m.role] ?? m.role}</span>
          <Text value={m.content} />
        </li>
      ))}
    </ol>
  );
}

const ROLE_LABELS: Record<string, string> = { system: "System", user: "User", assistant: "Assistant" };

/**
 * Prose (prompt messages, replies) in the body face: the mono stack has no Arabic face yet
 * (ADR-021, proposed), and Arabic set in a fallback mono reads letter by letter.
 */
function Text({ value }: { value: string }) {
  return (
    <p dir="auto" className="whitespace-pre-wrap break-words text-small text-primary">
      {value}
    </p>
  );
}

function Code({ value }: { value: string }) {
  return (
    <pre dir="ltr" className="overflow-x-auto rounded-xs bg-surface p-3 font-mono text-code-small text-primary">
      <code>{value}</code>
    </pre>
  );
}

/** JSON as a tree: objects and arrays fold; the first two levels start open. */
export function JsonTree({ value, depth = 0, name }: { value: Json; depth?: number; name?: string }) {
  const [open, setOpen] = useState(depth < 2);
  const label = name === undefined ? null : <span className="text-secondary">{name}: </span>;
  if (value === null || typeof value !== "object")
    return (
      <div className="font-mono text-code-small">
        {label}
        <span dir="auto" className={typeof value === "string" ? "text-primary" : "text-accent"}>
          {JSON.stringify(value)}
        </span>
      </div>
    );
  const entries: [string, Json][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, Json>);
  const Chevron = open ? ChevronDown : ChevronRight;
  const brackets = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return (
    <div className="font-mono text-code-small">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-xs text-start hover:bg-muted"
      >
        <Chevron className="size-icon-sm text-tertiary" strokeWidth={1.75} aria-hidden="true" />
        {label}
        <span className="text-tertiary">
          {brackets[0]}
          {open ? "" : ` ${entries.length} ${entries.length === 1 ? "item" : "items"} ${brackets[1]}`}
        </span>
      </button>
      {open ? (
        <div className="ms-2 border-s border-hairline ps-3">
          {entries.map(([k, v]) => (
            <JsonTree key={k} value={v} depth={depth + 1} name={k} />
          ))}
          <span className="text-tertiary">{brackets[1]}</span>
        </div>
      ) : null}
    </div>
  );
}
