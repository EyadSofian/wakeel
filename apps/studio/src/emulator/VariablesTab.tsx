import type { EmulatorVariable, Json, VariableScope } from "@wakeel/contracts";
import { Lock } from "lucide-react";
import { useCanvas } from "../canvas/context";
import { useEmulator } from "./controller";

const SCOPES: { scope: VariableScope; label: string }[] = [
  { scope: "conversation", label: "Conversation" },
  { scope: "user", label: "User" },
  { scope: "workflow", label: "Workflow" },
  { scope: "bot", label: "Bot" },
];

/**
 * The Variables tab's body (§5.3): current values by scope after each turn. Values changed in the
 * last turn are highlighted. Sensitive values are never sent to the Studio, so they show as hidden.
 * The tab header, with the size meter, is the trace area's (TraceArea.tsx).
 */
export function VariablesBody() {
  const snapshot = useEmulator((s) => s.variables);
  const changed = useEmulator((s) => s.changed);
  const started = useEmulator((s) => s.started);
  const workflows = useCanvas((s) => s.workflows);
  const workflowName = (id: string | undefined) => (id ? workflows[id]?.doc.name : undefined);
  if (!snapshot)
    return (
      <p className="py-3 text-small text-secondary">
        {started
          ? "The variables could not be loaded. Send another message to try again."
          : "Variables appear after the first turn."}
      </p>
    );
  return (
    <div className="flex flex-col gap-5">
      {SCOPES.map(({ scope, label }) => {
        const vars = snapshot.variables.filter((v) => v.scope === scope);
        if (vars.length === 0) return null;
        const heading = scope === "workflow" ? `${label} · ${workflowName(vars[0]?.workflowId) ?? "current"}` : label;
        return (
          <dl key={scope} className="flex flex-col gap-1">
            <dt className="text-micro font-medium text-secondary">{heading}</dt>
            {vars.map((v) => (
              <Row key={v.id} variable={v} changed={changed.has(v.id)} />
            ))}
          </dl>
        );
      })}
      {Object.keys(snapshot.attributes).length > 0 ? (
        <dl className="flex flex-col gap-1">
          <dt className="text-micro font-medium text-secondary">User attributes</dt>
          {Object.entries(snapshot.attributes).map(([key, value]) => (
            <dd key={key} className="flex items-baseline gap-3 rounded-xs px-2 py-1">
              <span className="shrink-0 font-mono text-code-small text-secondary">{key}</span>
              <Value value={value} />
            </dd>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function Row({ variable, changed }: { variable: EmulatorVariable; changed: boolean }) {
  return (
    <dd
      className={`flex items-baseline gap-3 rounded-xs px-2 py-1 ${changed ? "bg-accent-subtle" : ""}`}
      title={changed ? "Changed in the last turn" : undefined}
    >
      <span className="shrink-0 font-mono text-code-small text-secondary">{variable.name}</span>
      {variable.sensitive ? (
        <span className="flex items-center gap-1 text-small text-tertiary">
          <Lock className="size-icon-sm" strokeWidth={1.75} aria-hidden="true" />
          Hidden
        </span>
      ) : (
        <Value value={variable.value} />
      )}
      {changed ? <span className="sr-only">Changed in the last turn</span> : null}
    </dd>
  );
}

function Value({ value }: { value: Json | null }) {
  if (value === null) return <span className="text-small text-tertiary">Not set</span>;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (
    <span dir="auto" title={text} className="min-w-0 truncate text-small text-primary">
      {text}
    </span>
  );
}

export function SizeMeter({ used, limit }: { used: number; limit: number }) {
  const kb = (n: number) => `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  const ratio = Math.min(1, used / limit);
  return (
    <span className="ms-auto flex items-center gap-2 text-micro text-secondary">
      <span className="tabular-nums">
        {kb(used)} of {kb(limit)}
      </span>
      {/* The text beside it says the same; the bar is a glance aid only. */}
      <span aria-hidden="true" className="h-1 w-tile overflow-hidden rounded-full bg-muted">
        {/* A data-driven width, not a design value; the colours are tokens. */}
        <span
          className={`block h-full rounded-full ${ratio >= 0.8 ? "bg-warning" : "bg-accent"}`}
          style={{ width: `${Math.max(2, Math.round(ratio * 100))}%` }}
        />
      </span>
    </span>
  );
}
