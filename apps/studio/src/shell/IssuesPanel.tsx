import type { DefinitionIssue } from "@wakeel/contracts";
import { Kbd, Sheet, Skeleton } from "@wakeel/ui";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { Fragment, useMemo, useRef } from "react";
import { useCanvas } from "../canvas/context";
import { canJump, issueKey, issueLocationParts, orderIssues } from "./issue-order";
import { useShell, useShellState } from "./shell-store";
import { useGoTo } from "./use-go-to";

/**
 * The Issues panel (design system §5.16, task 2.8): a sheet from the end edge listing errors, then
 * warnings, each with what happened, the fix and where. Choosing one closes the sheet and jumps to
 * the node or field, which gets focus. `F8` / `⇧F8` step through the same list without it.
 */
export function IssuesPanel() {
  const { store, issues } = useShell();
  const open = useShellState((s) => s.issuesPanel);
  const ordered = useMemo(() => (issues ? orderIssues(issues) : undefined), [issues]);
  const errors = ordered?.filter((i) => i.severity === "error").length ?? 0;
  const warnings = (ordered?.length ?? 0) - errors;
  // After a jump the field or node has focus; closing must not hand it back to the top bar.
  const jumped = useRef(false);
  const description =
    ordered === undefined
      ? "Checking the bot…"
      : ordered.length === 0
        ? "Nothing to fix"
        : [plural(errors, "error"), plural(warnings, "warning")].filter(Boolean).join(", ");
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => store.getState().set({ issuesPanel: next })}
      title="Issues"
      description={description}
      onCloseAutoFocus={(e) => {
        if (jumped.current) e.preventDefault();
        jumped.current = false;
      }}
    >
      {ordered === undefined ? (
        <Loading />
      ) : (
        <List
          issues={ordered}
          onJump={() => {
            jumped.current = true;
          }}
        />
      )}
    </Sheet>
  );
}

const plural = (n: number, noun: string) => (n === 0 ? "" : `${n} ${n === 1 ? noun : `${noun}s`}`);

function List({ issues, onJump }: { issues: DefinitionIssue[]; onJump: () => void }) {
  const { store } = useShell();
  const workflows = useCanvas((s) => s.workflows);
  const docs = useMemo(() => Object.fromEntries(Object.entries(workflows).map(([id, w]) => [id, w.doc])), [workflows]);
  const go = useGoTo();
  if (issues.length === 0) {
    return (
      <p className="px-7 py-11 text-center text-body text-secondary">
        Errors and warnings in this bot appear here as you build. There are none now.
      </p>
    );
  }
  return (
    <div className="flex flex-col">
      {(["error", "warning"] as const).map((severity) => {
        const group = issues.filter((i) => i.severity === severity);
        if (group.length === 0) return null;
        const title = severity === "error" ? "Errors" : "Warnings";
        return (
          <section key={severity} aria-label={title} className="flex flex-col">
            <h3 className="border-b border-hairline bg-subtle px-7 py-3 text-small font-medium text-secondary">
              {title} <span className="tabular-nums text-tertiary">{group.length}</span>
            </h3>
            <ul className="flex flex-col">
              {group.map((issue) => {
                const Icon = issue.severity === "error" ? CircleAlert : TriangleAlert;
                const where = issueLocationParts(issue, docs);
                const body = (
                  <>
                    <Icon
                      className={`mt-1 size-icon shrink-0 ${issue.severity === "error" ? "text-error" : "text-warning"}`}
                      strokeWidth={1.75}
                      aria-label={issue.severity === "error" ? "Error" : "Warning"}
                    />
                    <span className="flex min-w-0 flex-col gap-1">
                      {/* Messages and fixes are English sentences that quote names; only the names are isolated. */}
                      <span className="text-body text-primary">{issue.message}</span>
                      <span className="text-small text-secondary">{issue.fix}</span>
                      <span className="truncate text-small text-tertiary">
                        {where.map((part, i) => (
                          <Fragment key={where.slice(0, i + 1).join(" › ")}>
                            {i > 0 ? " › " : null}
                            <bdi>{part}</bdi>
                          </Fragment>
                        ))}
                      </span>
                    </span>
                  </>
                );
                return (
                  <li key={issueKey(issue)} className="border-b border-hairline">
                    {canJump(issue) ? (
                      <button
                        type="button"
                        onClick={() => {
                          onJump();
                          store.getState().set({ issuesPanel: false, issueAt: issueKey(issue) });
                          go.place({
                            workflowId: issue.workflowId,
                            ...(issue.nodeId ? { nodeId: issue.nodeId } : {}),
                            ...(issue.cardId ? { cardId: issue.cardId } : {}),
                            path: issue.path,
                          });
                        }}
                        className="flex w-full gap-4 px-7 py-5 text-start transition-colors hover:bg-subtle"
                      >
                        {body}
                      </button>
                    ) : (
                      <div className="flex gap-4 px-7 py-5">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      <p className="flex items-center gap-2 px-7 py-5 text-small text-tertiary">
        <Kbd>F8</Kbd> next issue <span aria-hidden="true">·</span> <Kbd>⇧</Kbd>
        <Kbd>F8</Kbd> previous, from anywhere in the bot
      </p>
    </div>
  );
}

function Loading() {
  return (
    <div role="status" aria-busy="true" aria-label="Checking the bot" className="flex flex-col">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-4 border-b border-hairline px-7 py-5">
          <Skeleton className="size-icon rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-3 w-12" />
          </div>
        </div>
      ))}
    </div>
  );
}
