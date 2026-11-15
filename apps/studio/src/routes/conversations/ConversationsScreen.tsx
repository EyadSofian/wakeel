import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import {
  ConversationHistoryPage,
  ConversationStatus,
  ConversationTranscriptPage,
  ReplayResult,
  ReplayTurnResponse,
  Trace,
} from "@wakeel/contracts";
import { Badge, Button, EmptyState, Field, Input, MessageBubble, Select, Sheet, Skeleton } from "@wakeel/ui";
import { type ReactNode, useRef, useState } from "react";
import { api } from "../../api/client";
import { useConnections } from "../../api/connections";
import { AppShell } from "../../shell/AppShell";
import { Page, PageHeader } from "../../shell/PageHeader";
import { ProblemBanner } from "../../shell/ProblemBanner";
import { formatDuration, stepRows } from "../../trace/model";
import { PayloadViewer, payloadTabs } from "../../trace/PayloadViewer";
import { Breadcrumb } from "../bot/BotCanvas";
import { useLoadState } from "../bot/BotLayout";
import { AddConversationCase } from "../evals/AddConversationCase";

type Item = (typeof ConversationHistoryPage._output)["data"][number];
const statusName = (status: string) => status.charAt(0).toUpperCase() + status.slice(1).replaceAll("_", " ");
const date = (value: string) => new Date(value).toLocaleString();

export function ConversationsScreen({ workspaceId, botId }: { workspaceId: string; botId: string }) {
  const path = `/v1/workspaces/${workspaceId}/bots/${botId}/conversations`;
  const ready = useLoadState() === "ready";
  const [filter, setFilter] = useState("");
  const [selected, select] = useState<string>();
  const rows = useInfiniteQuery({
    queryKey: ["conversation-history", path, filter],
    queryFn: async ({ pageParam }) => {
      const q = new URLSearchParams(filter);
      if (pageParam) q.set("cursor", pageParam);
      return ConversationHistoryPage.parse(await api("GET", `${path}?${q}`));
    },
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const conversations = rows.data?.pages.flatMap((part) => part.data) ?? [];
  return (
    <AppShell
      title={<Breadcrumb workspaceId={workspaceId} ready={ready} page="Conversations" />}
      workspaceId={workspaceId}
      botId={botId}
      active="Conversations"
    >
      <Page>
        <PageHeader title="Conversations" />
        <div className="grid grid-cols-3 gap-8">
          <section aria-label="Conversation list" className="flex min-w-0 flex-col gap-4">
            <Filters
              workspaceId={workspaceId}
              botId={botId}
              apply={(q) => {
                setFilter(q);
                select(undefined);
              }}
            />
            {rows.isError ? (
              <ProblemBanner error={rows.error} />
            ) : rows.isPending ? (
              <Skeleton className="h-12 w-full" />
            ) : conversations.length === 0 ? (
              <EmptyState title="No conversations" detail="Change the filters or wait for a live conversation." />
            ) : (
              <ul className="flex flex-col divide-y divide-hairline rounded-lg border border-hairline bg-surface">
                {conversations.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-pressed={selected === item.id}
                      className={`flex w-full min-w-0 flex-col gap-2 px-5 py-4 text-start hover:bg-subtle ${selected === item.id ? "bg-accent-subtle" : ""}`}
                      onClick={() => select(item.id)}
                    >
                      <span dir="auto" className="w-full truncate text-title">
                        {item.user.name || item.user.externalId}
                      </span>
                      <span className="flex flex-wrap items-center gap-3">
                        <span dir="auto" className="text-small text-secondary">
                          {item.connectionName}
                        </span>
                        <Badge>{statusName(item.status)}</Badge>
                        {item.hasError && <Badge tone="error">Error</Badge>}
                      </span>
                      <time dateTime={item.lastActivityAt} className="text-small text-secondary">
                        {date(item.lastActivityAt)}
                      </time>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {rows.hasNextPage && (
              <Button disabled={rows.isFetchingNextPage} onClick={() => void rows.fetchNextPage()}>
                Load more conversations
              </Button>
            )}
          </section>
          <div className="col-span-2 min-w-0">
            {selected ? (
              <Transcript key={selected} path={`${path}/${selected}`} workspaceId={workspaceId} />
            ) : (
              <EmptyState
                title="Select a conversation"
                detail="Choose a conversation to read its transcript and steps."
              />
            )}
          </div>
        </div>
      </Page>
    </AppShell>
  );
}

function Filters({ workspaceId, botId, apply }: { workspaceId: string; botId: string; apply(q: string): void }) {
  const connections = useConnections(workspaceId, botId);
  const [notice, setNotice] = useState("");
  return (
    <form
      className="grid min-w-0 grid-cols-2 gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const q = new URLSearchParams();
        for (const name of ["search", "connectionId", "status", "hasError", "handedOff"]) {
          const value = String(data.get(name) ?? "").trim();
          if (value) q.set(name, value);
        }
        const from = String(data.get("from") ?? "");
        const to = String(data.get("until") ?? "");
        if (from && to && from > to) {
          setNotice("Choose an end date on or after the start date.");
          return;
        }
        if (from) q.set("from", new Date(`${from}T00:00:00`).toISOString());
        if (to) {
          const end = new Date(`${to}T00:00:00`);
          end.setDate(end.getDate() + 1);
          q.set("until", end.toISOString());
        }
        setNotice("");
        apply(q.toString());
      }}
    >
      <div className="col-span-2">
        <Field label="Search conversations">
          {(props) => <Input {...props} dir="auto" name="search" maxLength={250} />}
        </Field>
      </div>
      <Field label="Connection">
        {(props) => (
          <Select {...props} name="connectionId">
            <option value="">All connections</option>
            {connections.data?.map((item) => (
              <option key={item.id} value={item.id} dir="auto">
                {item.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Status">
        {(props) => (
          <Select {...props} name="status">
            <option value="">All statuses</option>
            {ConversationStatus.options.map((status) => (
              <option key={status} value={status}>
                {statusName(status)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="From date">{(props) => <Input {...props} type="date" name="from" />}</Field>
      <Field label="To date">{(props) => <Input {...props} type="date" name="until" />}</Field>
      <label className="flex items-center gap-2 text-small">
        <input type="checkbox" name="hasError" value="true" />
        Has an error
      </label>
      <label className="flex items-center gap-2 text-small">
        <input type="checkbox" name="handedOff" value="true" />
        Handed off
      </label>
      <div className="col-span-2 flex gap-3">
        <Button type="submit">Apply filters</Button>
        <Button
          type="reset"
          onClick={() => {
            setNotice("");
            apply("");
          }}
        >
          Clear
        </Button>
      </div>
      {notice && (
        <p className="col-span-2 text-small text-error" role="alert">
          {notice}
        </p>
      )}
      {connections.isError && (
        <div className="col-span-2">
          <ProblemBanner error={connections.error} />
        </div>
      )}
    </form>
  );
}

function Transcript({ path, workspaceId }: { path: string; workspaceId: string }) {
  const [turn, setTurn] = useState<string>();
  const opener = useRef<HTMLButtonElement | null>(null);
  const transcript = useInfiniteQuery({
    queryKey: ["conversation-transcript", path],
    queryFn: async ({ pageParam }) =>
      ConversationTranscriptPage.parse(
        await api("GET", `${path}${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`),
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  if (transcript.isError) return <ProblemBanner error={transcript.error} />;
  if (transcript.isPending) return <Skeleton className="h-12 w-full" />;
  const conversation = transcript.data.pages[0]?.conversation;
  if (!conversation) return null;
  const messages = transcript.data.pages.toReversed().flatMap((p) => p.messages);
  return (
    <section
      aria-label="Transcript"
      className="flex min-w-0 flex-col gap-5 rounded-lg border border-hairline bg-surface p-6"
    >
      <TranscriptHeader conversation={conversation}>
        <AddConversationCase
          path={path.slice(0, path.lastIndexOf("/conversations")) + "/evals"}
          messages={messages}
          hasEarlier={transcript.hasNextPage === true}
        />
      </TranscriptHeader>
      {transcript.hasNextPage && (
        <Button onClick={() => void transcript.fetchNextPage()} disabled={transcript.isFetchingNextPage}>
          Load earlier messages
        </Button>
      )}
      {!messages.length && (
        <EmptyState title="No messages yet" detail="Messages will appear here when the conversation starts." />
      )}
      {messages.map((message, index) => (
        <div key={message.id} className="flex flex-col gap-2">
          <MessageBubble
            disabled
            direction={message.direction}
            payload={message.payload}
            citations={message.citations}
          />
          {message.direction === "out" && message.turnId && messages[index + 1]?.turnId !== message.turnId && (
            <Button
              size="compact"
              variant="ghost"
              className="self-start"
              onClick={(event) => {
                opener.current = event.currentTarget;
                setTurn(message.turnId);
              }}
            >
              Open trace
            </Button>
          )}
        </div>
      ))}
      <Sheet
        open={turn !== undefined}
        title="Turn trace"
        onOpenChange={(open) => {
          if (!open) setTurn(undefined);
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          opener.current?.focus();
        }}
      >
        {turn && (
          <TraceDetail
            key={turn}
            workspaceId={workspaceId}
            turn={turn}
            replayBase={path.slice(0, path.lastIndexOf("/conversations"))}
          />
        )}
      </Sheet>
    </section>
  );
}

function TranscriptHeader({ conversation, children }: { conversation: Item; children: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-5 border-b border-hairline pb-5">
      <div className="min-w-0">
        <h2 dir="auto" className="break-words text-title">
          {conversation.user.name || conversation.user.externalId}
        </h2>
        <p dir="auto" className="text-small text-secondary">
          {conversation.user.externalId}
        </p>
      </div>
      <Badge>{statusName(conversation.status)}</Badge>
      {children}
    </header>
  );
}

export function TraceDetail({
  workspaceId,
  turn,
  replayBase,
}: {
  workspaceId: string;
  turn: string;
  replayBase?: string;
}) {
  const trace = useQuery({
    queryKey: ["history-trace", workspaceId, turn],
    queryFn: async () => Trace.parse(await api("GET", `/v1/workspaces/${workspaceId}/turns/${turn}/trace`)),
  });
  const [selected, select] = useState<string>();
  if (trace.isError)
    return (
      <div className="p-6">
        <ProblemBanner error={trace.error} />
      </div>
    );
  if (trace.isPending)
    return (
      <div className="p-6">
        <Skeleton className="h-12 w-full" />
      </div>
    );
  const { spans } = trace.data;
  const current = spans.find((span) => span.id === selected);
  return (
    <div className="flex flex-col gap-4 p-6">
      {replayBase && <ReplayPanel base={replayBase} turn={turn} />}
      <ol aria-label="Steps" className="flex flex-col gap-2">
        {stepRows(spans).map(({ span }) => (
          <li key={span.id}>
            <Button
              variant="ghost"
              aria-pressed={span.id === selected}
              className="w-full justify-between"
              onClick={() => select(span.id)}
            >
              <span dir="auto" className="truncate">
                {span.name}
              </span>
              <span className="text-small text-secondary">{formatDuration(span.durationMs)}</span>
            </Button>
          </li>
        ))}
      </ol>
      {current &&
        (Object.keys(payloadTabs(current, spans)).length > 0 ? (
          <PayloadViewer span={current} spans={spans} />
        ) : current.kind === "error" ? (
          <p dir="auto" className="text-small text-error">
            {current.attrs.message} {current.attrs.fix}
          </p>
        ) : (
          <p className="text-small text-secondary">{statusName(current.status)}</p>
        ))}
    </div>
  );
}

function ReplayPanel({ base, turn }: { base: string; turn: string }) {
  const [allow, setAllow] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const replay = useMutation({
    mutationFn: async () =>
      ReplayTurnResponse.parse(
        await api("POST", `${base}/emulator/replay/${turn}`, { requestId, allowSideEffects: allow }),
      ),
  });
  const result = useQuery({
    queryKey: ["replay-result", base, replay.data?.turnId],
    enabled: Boolean(replay.data),
    queryFn: async () => ReplayResult.parse(await api("GET", `${base}/emulator/replay/${replay.data?.turnId}`)),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && status !== "running" && status !== "queued" ? false : 1000;
    },
    retry: false,
  });
  return (
    <section aria-label="Replay on draft" className="flex flex-col gap-3 rounded-sm border border-hairline p-4">
      <p className="text-small text-secondary">Run the recorded input on the current draft from its defaults.</p>
      <label className="flex items-start gap-2 text-small">
        <input
          type="checkbox"
          checked={allow}
          onChange={(event) => {
            setAllow(event.target.checked);
            setRequestId(crypto.randomUUID());
            replay.reset();
          }}
        />
        Allow code with external side effects for this replay
      </label>
      <Button disabled={replay.isPending} onClick={() => replay.mutate()}>
        Replay on draft
      </Button>
      {replay.isError && <ProblemBanner error={replay.error} />}
      {replay.data && (
        <p role="status" className="text-small">
          {result.data ? statusName(result.data.status) : "Waiting for replay"}
        </p>
      )}
      {result.isError && <ProblemBanner error={result.error} />}
      {result.data?.messages.map((message) => (
        <MessageBubble
          key={message.id}
          disabled
          direction={message.direction}
          payload={message.payload}
          citations={message.citations}
        />
      ))}
      {result.data?.trace?.spans
        .filter((span) => span.kind === "error")
        .map(
          (span) =>
            span.kind === "error" && (
              <p key={span.id} dir="auto" className="text-small text-error">
                {span.attrs.message} {span.attrs.fix}
              </p>
            ),
        )}
    </section>
  );
}
