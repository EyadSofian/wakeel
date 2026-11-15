import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EvalCase, EvalCaseEntry, EvalRun, EvalRunDetail, EvalSuite, EvalTarget, Message } from "@wakeel/contracts";
import { Badge, Button, EmptyState, Field, Input, MessageBubble, Select, Sheet, Skeleton, Textarea } from "@wakeel/ui";
import { type FormEvent, useRef, useState } from "react";
import { z } from "zod";
import { api } from "../../api/client";
import { evalsPath, useEvalSuites } from "../../api/evals";
import { useVersions } from "../../api/versions";
import { AppShell } from "../../shell/AppShell";
import { Page, PageHeader } from "../../shell/PageHeader";
import { ProblemBanner } from "../../shell/ProblemBanner";
import { Breadcrumb } from "../bot/BotCanvas";
import { useLoadState } from "../bot/BotLayout";
import { TraceDetail } from "../conversations/ConversationsScreen";

const suiteSchema = EvalSuite.extend({ cases: z.array(EvalCaseEntry) });
const runsPage = z.object({ data: z.array(EvalRun), nextCursor: z.string().nullable() });
const starter = { name: "", tags: ["ar-EG"], turns: [{ user: "", assert: [{ type: "contains", text: "" }] }] };
type Case = z.infer<typeof EvalCaseEntry>;
type Run = z.infer<typeof EvalRunDetail>;

export function EvalsScreen({ workspaceId, botId }: { workspaceId: string; botId: string }) {
  const path = evalsPath(workspaceId, botId);
  const ready = useLoadState() === "ready";
  const query = useEvalSuites(path);
  const client = useQueryClient();
  const [selection, select] = useState<string>();
  const [name, setName] = useState("");
  const suites = query.data?.pages.flatMap((part) => part.data) ?? [];
  const active = selection ?? suites[0]?.id;
  const add = useMutation({
    mutationFn: async (title: string) => EvalSuite.parse(await api("POST", `${path}/suites`, { name: title })),
    onSuccess: (suite) => {
      select(suite.id);
      setName("");
      void client.invalidateQueries({ queryKey: ["eval-suites", path] });
    },
  });
  return (
    <AppShell
      title={<Breadcrumb workspaceId={workspaceId} ready={ready} page="Evals" />}
      workspaceId={workspaceId}
      botId={botId}
      active="Evals"
    >
      <Page>
        <PageHeader title="Evals" description="Run scripted conversations against a draft or a published version." />
        <form
          className="flex flex-wrap items-end gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate(name.trim());
          }}
        >
          <Field label="Suite name">
            {(props) => (
              <Input
                {...props}
                dir="auto"
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <Button type="submit" disabled={!name.trim() || add.isPending}>
            New suite
          </Button>
        </form>
        {add.isError && <ProblemBanner error={add.error} />}
        {query.isError ? (
          <ProblemBanner error={query.error} />
        ) : query.isPending ? (
          <Skeleton className="h-12 w-full" />
        ) : (
          <>
            {!active && <EmptyState title="No eval suites" detail="Create a suite to organise your cases." />}
            {suites.length > 0 && (
              <Field label="Suite">
                {(props) => (
                  <Select {...props} value={active} onChange={(event) => select(event.target.value)}>
                    {suites.map((suite) => (
                      <option key={suite.id} value={suite.id} dir="auto">
                        {suite.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            {query.hasNextPage && (
              <Button disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                Load more suites
              </Button>
            )}
            {active && <SuiteView key={active} workspaceId={workspaceId} botId={botId} path={path} suiteId={active} />}
          </>
        )}
      </Page>
    </AppShell>
  );
}

function SuiteView({
  workspaceId,
  botId,
  path,
  suiteId,
}: {
  workspaceId: string;
  botId: string;
  path: string;
  suiteId: string;
}) {
  const base = `${path}/suites/${suiteId}`;
  const client = useQueryClient();
  const versions = useVersions(workspaceId, botId);
  const [target, setTarget] = useState("draft");
  const [editing, setEditing] = useState<Case | "new">();
  const editorTrigger = useRef<HTMLElement | null>(null);
  const [runId, setRunId] = useState<string>();
  const suite = useQuery({
    queryKey: ["eval-suite", base],
    queryFn: async () => suiteSchema.parse(await api("GET", base)),
  });
  const runs = useInfiniteQuery({
    queryKey: ["eval-runs", base],
    initialPageParam: "",
    queryFn: async ({ pageParam }) =>
      runsPage.parse(await api("GET", `${base}/runs${pageParam ? `?cursor=${pageParam}` : ""}`)),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const history = runs.data?.pages.flatMap((page) => page.data) ?? [];
  const selectedRun = runId ?? history[0]?.id;
  const result = useQuery({
    enabled: !!selectedRun,
    queryKey: ["eval-run", path, selectedRun],
    queryFn: async () => EvalRunDetail.parse(await api("GET", `${path}/runs/${selectedRun}`)),
    refetchInterval: ({ state }) => (!state.data || ["queued", "running"].includes(state.data.status) ? 1000 : false),
  });
  const run = useMutation({
    mutationFn: async () =>
      EvalRun.parse(
        await api(
          "POST",
          `${base}/runs`,
          EvalTarget.parse(target === "draft" ? { kind: "draft" } : { kind: "version", versionId: target }),
        ),
      ),
    onSuccess: (item) => {
      setRunId(item.id);
      void client.invalidateQueries({ queryKey: ["eval-runs", base] });
    },
  });
  if (suite.isError) return <ProblemBanner error={suite.error} />;
  if (suite.isPending) return <Skeleton className="h-12 w-full" />;
  return (
    <section className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Target">
          {(props) => (
            <Select {...props} value={target} onChange={(event) => setTarget(event.target.value)}>
              <option value="draft">Draft</option>
              {versions.data?.map((version) => (
                <option key={version.id} value={version.id} dir="auto">
                  v{version.number} {version.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button
          variant="primary"
          onClick={() => run.mutate()}
          disabled={
            !suite.data.cases.length || run.isPending || ["queued", "running"].includes(result.data?.status ?? "")
          }
        >
          Run all
        </Button>
        <Button
          onClick={(event) => {
            editorTrigger.current = event.currentTarget;
            setEditing("new");
          }}
        >
          Add case
        </Button>
      </div>
      {run.isError && <ProblemBanner error={run.error} />}
      {versions.isError && <ProblemBanner error={versions.error} />}
      {runs.isError && <ProblemBanner error={runs.error} />}
      {suite.data.cases.length === 0 ? (
        <EmptyState title="No cases" detail="Add a scripted conversation and its assertions." />
      ) : (
        <ul className="divide-y divide-hairline rounded-lg border border-hairline bg-surface">
          {suite.data.cases.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-4 px-5 py-3">
              <button
                type="button"
                className="text-accent hover:underline"
                dir="auto"
                onClick={(event) => {
                  editorTrigger.current = event.currentTarget;
                  setEditing(item);
                }}
              >
                {item.script.name}
              </button>
              {[...new Set(item.script.tags)].map((tag) => (
                <Badge key={tag}>
                  <span dir="auto">{tag}</span>
                </Badge>
              ))}
              <span className="text-small text-secondary">
                {item.script.turns.length} {item.script.turns.length === 1 ? "turn" : "turns"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {history.length > 0 && (
        <Field label="Run history">
          {(props) => (
            <Select {...props} value={selectedRun} onChange={(event) => setRunId(event.target.value)}>
              {history.map((item) => (
                <option key={item.id} value={item.id}>
                  {new Date(item.createdAt).toLocaleString()}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {runs.hasNextPage && (
        <Button disabled={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>
          Load more runs
        </Button>
      )}
      {result.isError && <ProblemBanner error={result.error} />}
      {selectedRun && result.isPending && <Skeleton className="h-12 w-full" />}
      {result.data && <RunView run={result.data} workspaceId={workspaceId} path={path} />}
      <Sheet
        open={editing !== undefined}
        title={editing === "new" ? "Add case" : "Edit case"}
        onCloseAutoFocus={(event) => {
          // This controlled sheet has separate add/edit triggers, so restore the actual opener.
          event.preventDefault();
          editorTrigger.current?.focus();
        }}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined);
        }}
      >
        {editing && (
          <CaseEditor
            key={editing === "new" ? "new" : editing.id}
            base={base}
            item={editing === "new" ? undefined : editing}
            onSaved={() => {
              setEditing(undefined);
              void client.invalidateQueries({ queryKey: ["eval-suite", base] });
            }}
          />
        )}
      </Sheet>
    </section>
  );
}

function CaseEditor({ base, item, onSaved }: { base: string; item: Case | undefined; onSaved: () => void }) {
  const [value, setValue] = useState(JSON.stringify(item?.script ?? starter, null, 2));
  const [problem, setProblem] = useState("");
  const save = useMutation({
    mutationFn: async (script: z.infer<typeof EvalCase>) =>
      EvalCaseEntry.parse(
        await (item
          ? api("PUT", `${base}/cases/${item.id}`, script, { "if-match": `"${item.revision}"` })
          : api("POST", `${base}/cases`, script)),
      ),
    onSuccess: onSaved,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    let raw: unknown;
    try {
      raw = JSON.parse(value);
    } catch {
      setProblem("Enter valid JSON. Check the quotes, commas and brackets.");
      return;
    }
    const parsed = EvalCase.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      setProblem(`Check ${first?.path.join(".") || "the case"}. ${first?.message ?? "Enter a valid case."}`);
      return;
    }
    setProblem("");
    save.mutate(parsed.data);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-5 p-6">
      <Field label="Case script" help="Write the turns and assertions as JSON." error={problem || undefined}>
        {(props) => (
          <Textarea
            {...props}
            dir="ltr"
            className="font-mono text-code-small"
            rows={18}
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
      </Field>
      {save.isError && <ProblemBanner error={save.error} />}
      <Button type="submit" disabled={save.isPending} variant="primary" className="self-start">
        Save case
      </Button>
    </form>
  );
}

const names: Record<z.infer<typeof EvalRun>["status"], string> = {
  queued: "Queued",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  error: "Error",
};
function RunView({ run, workspaceId, path }: { run: Run; workspaceId: string; path: string }) {
  const [trace, setTrace] = useState<string>();
  const tags = new Map<string, { passed: number; total: number }>();
  const done = new Map(run.results.map((item) => [item.caseId, item.result]));
  for (const item of run.cases) {
    const result = done.get(item.id);
    if (!result) continue;
    for (const tag of new Set(item.script.tags)) {
      const counts = tags.get(tag) ?? { passed: 0, total: 0 };
      counts.total++;
      if (result.status === "passed") counts.passed++;
      tags.set(tag, counts);
    }
  }
  return (
    <section aria-label="Run results" className="flex flex-col gap-4">
      <h2 className="text-title">Run results</h2>
      <p role="status" className="text-body">
        {names[run.status]} · {run.results.length}/{run.cases.length} cases
      </p>
      <ul aria-label="Scores by tag" className="flex flex-wrap gap-3">
        {[...tags].map(([tag, score]) => (
          <li key={tag}>
            <Badge>
              <span dir="auto">
                {tag} {score.passed}/{score.total}
              </span>
            </Badge>
          </li>
        ))}
      </ul>
      {run.cases.map((item) => {
        const outcome = done.get(item.id);
        if (!outcome) return null;
        return (
          <details key={item.id} className="rounded-md border border-hairline bg-surface p-5">
            <summary className="cursor-pointer text-body">
              <bdi>{item.script.name}</bdi> · {names[outcome.status]}
            </summary>
            {outcome.errorCode && <p className="mt-3 text-small text-error">{outcome.errorCode}</p>}
            {outcome.turns.map((turn) => (
              <section key={turn.index} className="mt-4 flex flex-col gap-2 border-t border-hairline pt-3">
                <h3 className="text-small font-medium">Turn {turn.index + 1}</h3>
                {turn.silencePassed !== undefined && (
                  <p className="text-small">Silence · {turn.silencePassed ? "Passed" : "Failed"}</p>
                )}
                <ul className="flex flex-col gap-2">
                  {turn.assertions.map(({ assertion, passed }, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: completed turn assertions are immutable and may repeat.
                    <li key={index} className="flex flex-wrap items-center gap-3 text-small">
                      <Badge tone={passed ? "success" : "error"}>{passed ? "Passed" : "Failed"}</Badge>
                      <span>{assertion.type}</span>
                    </li>
                  ))}
                </ul>
                {turn.turnId && (
                  <TurnOutput
                    path={`${path}/runs/${run.id}/turns/${turn.turnId}/messages`}
                    openTrace={() => setTrace(turn.turnId)}
                  />
                )}
              </section>
            ))}
          </details>
        );
      })}
      <Sheet
        title="Turn trace"
        open={trace !== undefined}
        onOpenChange={(open) => {
          if (!open) setTrace(undefined);
        }}
      >
        {trace && <TraceDetail key={trace} workspaceId={workspaceId} turn={trace} />}
      </Sheet>
    </section>
  );
}

function TurnOutput({ path, openTrace }: { path: string; openTrace: () => void }) {
  const [show, setShow] = useState(false);
  const messages = useQuery({
    enabled: show,
    queryKey: ["eval-turn-messages", path],
    queryFn: async () => z.object({ data: z.array(Message) }).parse(await api("GET", path)),
  });
  return (
    <>
      <div className="flex flex-wrap gap-3">
        <Button size="compact" aria-expanded={show} onClick={() => setShow(!show)}>
          {show ? "Hide replies" : "Show replies"}
        </Button>
        <Button size="compact" onClick={openTrace}>
          Open trace
        </Button>
      </div>
      {show &&
        (messages.isError ? (
          <ProblemBanner error={messages.error} />
        ) : messages.isPending ? (
          <Skeleton className="h-8 w-full" />
        ) : messages.data.data.length ? (
          messages.data.data.map((message) => (
            <MessageBubble
              key={message.id}
              disabled
              direction="out"
              payload={message.payload}
              citations={message.citations}
            />
          ))
        ) : (
          <p className="text-small text-secondary">The bot sent no replies.</p>
        ))}
    </>
  );
}
