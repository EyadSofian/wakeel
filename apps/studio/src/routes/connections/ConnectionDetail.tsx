import { Link } from "@tanstack/react-router";
import { curlExample, SIGNATURE_CHECKS } from "@wakeel/bridge/snippets";
import type { BridgeDelivery, StudioConnection, TurnResult } from "@wakeel/contracts";
import {
  Badge,
  Banner,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
  Table,
  Td,
  THead,
  Th,
  Tr,
  tabClasses,
} from "@wakeel/ui";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { fieldErrors } from "../../api/client";
import {
  type ConnectionKey,
  useConnection,
  useConnectionKeys,
  useCreateConnectionKey,
  useDeliveries,
  useFinishRotation,
  useReplay,
  useRevokeConnectionKey,
  useRotateSecret,
  useTestMessage,
  useTestWebhook,
  useUpdateConnection,
} from "../../api/connections";
import { AppShell } from "../../shell/AppShell";
import { Page, PageHeader } from "../../shell/PageHeader";
import { ProblemBanner } from "../../shell/ProblemBanner";
import { Breadcrumb } from "../bot/BotCanvas";
import { useLoadState } from "../bot/BotLayout";
import { canReplay, connectionStatus, deliveryStatus, describeError, TARGET_LABELS } from "./model";
import { CodeBlock, EventChecklist, ShownOnceDialog } from "./parts";

export type ConnectionTab = "setup" | "deliveries" | "test";

const TABS: { id: ConnectionTab; label: string; to: string }[] = [
  { id: "setup", label: "Setup", to: "/w/$workspaceId/b/$botId/connections/$connectionId" },
  { id: "deliveries", label: "Deliveries", to: "/w/$workspaceId/b/$botId/connections/$connectionId/deliveries" },
  { id: "test", label: "Test", to: "/w/$workspaceId/b/$botId/connections/$connectionId/test" },
];

const dateTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
const date = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

interface Ids {
  workspaceId: string;
  botId: string;
  connectionId: string;
}

/**
 * One connection (design system §5.11, task 5.5): Setup, Deliveries and Test. Tabs are links, so
 * each has its own address, as in Settings.
 */
export function ConnectionDetail({ tab, ...ids }: Ids & { tab: ConnectionTab }) {
  const ready = useLoadState() === "ready";
  const connection = useConnection(ids.workspaceId, ids.botId, ids.connectionId);
  const c = connection.data;
  const status = c ? connectionStatus(c) : undefined;

  return (
    <AppShell
      title={<Breadcrumb workspaceId={ids.workspaceId} ready={ready} page="Connections" />}
      active="Connections"
      workspaceId={ids.workspaceId}
      botId={ids.botId}
    >
      <Page>
        <div className="flex flex-col gap-6">
          <Link
            to="/w/$workspaceId/b/$botId/connections"
            params={{ workspaceId: ids.workspaceId, botId: ids.botId }}
            className="text-body text-secondary hover:text-primary"
          >
            All connections
          </Link>
          <PageHeader
            title={
              c ? (
                <span className="flex items-center gap-4">
                  <span dir="auto">{c.name}</span>
                  {status ? <Badge tone={status.tone}>{status.label}</Badge> : null}
                </span>
              ) : connection.isError ? (
                "Connection"
              ) : (
                <Skeleton className="h-5 w-12" />
              )
            }
            description={c ? `Runs the ${TARGET_LABELS[c.target].toLowerCase()} of this bot.` : undefined}
            actions={c ? <PauseButton {...ids} connection={c} /> : null}
          />
          {c?.status === "disabled" ? <DisabledBanner {...ids} connection={c} /> : null}
          {c?.status === "paused" ? (
            <Banner title="This connection is paused">
              Messages are still accepted, but no webhooks are sent until you resume it.
            </Banner>
          ) : null}
          <nav aria-label="Connection" className="flex gap-7 border-b border-hairline">
            {TABS.map((t) => (
              <Link
                key={t.id}
                to={t.to}
                params={ids}
                aria-current={t.id === tab ? "page" : undefined}
                className={tabClasses(t.id === tab)}
              >
                {t.label}
              </Link>
            ))}
          </nav>
        </div>
        {connection.isError ? (
          <div>
            <ProblemBanner error={connection.error} />
          </div>
        ) : !c ? (
          <LoadingSections />
        ) : tab === "setup" ? (
          <SetupTab {...ids} connection={c} />
        ) : tab === "deliveries" ? (
          <DeliveriesTab {...ids} />
        ) : (
          <TestTab {...ids} connection={c} />
        )}
      </Page>
    </AppShell>
  );
}

function LoadingSections() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </div>
  );
}

function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-5" aria-label={title}>
      <div className="flex items-end justify-between gap-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-title text-primary">{title}</h2>
          {description ? <p className="text-body text-secondary">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function PauseButton({ connection: c, ...ids }: Ids & { connection: StudioConnection }) {
  const update = useUpdateConnection(ids.workspaceId, ids.botId, ids.connectionId);
  if (c.status === "disabled") return null;
  return (
    <Button
      disabled={update.isPending}
      onClick={() => update.mutate({ status: c.status === "active" ? "paused" : "active" })}
    >
      {c.status === "active" ? "Pause" : "Resume"}
    </Button>
  );
}

function DisabledBanner({ connection: c, ...ids }: Ids & { connection: StudioConnection }) {
  const update = useUpdateConnection(ids.workspaceId, ids.botId, ids.connectionId);
  const problem = describeError("connection_disabled");
  return (
    <Banner tone="error" title={problem?.title ?? "This connection is turned off"}>
      <span className="flex flex-col items-start gap-4">
        <span>
          {c.consecutiveDead} events in a row could not be delivered. {problem?.fix}
        </span>
        <Button disabled={update.isPending} onClick={() => update.mutate({ status: "active" })}>
          Turn back on
        </Button>
      </span>
    </Banner>
  );
}

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

function SetupTab({ connection: c, ...ids }: Ids & { connection: StudioConnection }) {
  return (
    <div className="flex flex-col gap-10">
      <SettingsForm {...ids} connection={c} />
      <Keys {...ids} />
      <SigningSecret {...ids} connection={c} />
      <Examples />
    </div>
  );
}

function SettingsForm({ connection: c, ...ids }: Ids & { connection: StudioConnection }) {
  const update = useUpdateConnection(ids.workspaceId, ids.botId, ids.connectionId);
  const [name, setName] = useState(c.name);
  const [target, setTarget] = useState(c.target);
  const [webhookUrl, setWebhookUrl] = useState(c.webhookUrl ?? "");
  const [events, setEvents] = useState<string[]>(c.subscribedEvents);
  const errors = fieldErrors(update.error);
  useEffect(() => {
    setName(c.name);
    setTarget(c.target);
    setWebhookUrl(c.webhookUrl ?? "");
    setEvents(c.subscribedEvents);
  }, [c]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    update.mutate({
      name,
      target,
      webhookUrl: webhookUrl.trim() ? webhookUrl.trim() : null,
      subscribedEvents: events,
    } as Parameters<typeof update.mutate>[0]);
  };
  return (
    <Section title="Connection" description="What this bridge runs and where its webhooks go.">
      <form className="flex max-w-inspector-max flex-col gap-6" onSubmit={submit} noValidate>
        {update.isError && Object.keys(errors).length === 0 ? <ProblemBanner error={update.error} /> : null}
        <Field label="Name" error={errors["name"]}>
          {(p) => <Input {...p} dir="auto" value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Runs" error={errors["target"]}>
          {(p) => (
            <Select {...p} value={target} onChange={(e) => setTarget(e.target.value as "production" | "draft")}>
              <option value="production">{TARGET_LABELS.production}</option>
              <option value="draft">{TARGET_LABELS.draft}</option>
            </Select>
          )}
        </Field>
        <Field label="Webhook URL" help="Leave empty to stop sending webhooks." error={errors["webhookUrl"]}>
          {(p) => (
            <Input
              {...p}
              dir="ltr"
              inputMode="url"
              placeholder="https://"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
            />
          )}
        </Field>
        <EventChecklist value={events} onChange={setEvents} />
        <div>
          <Button type="submit" variant="primary" disabled={update.isPending}>
            Save changes
          </Button>
        </div>
      </form>
    </Section>
  );
}

function Keys(ids: Ids) {
  const keys = useConnectionKeys(ids.workspaceId, ids.botId, ids.connectionId);
  const create = useCreateConnectionKey(ids.workspaceId, ids.botId, ids.connectionId);
  const [naming, setNaming] = useState(false);
  const [revoking, setRevoking] = useState<ConnectionKey>();
  const active = (keys.data ?? []).filter((k) => k.revokedAt === null);
  return (
    <Section
      title="Keys"
      description="The bridge sends one of these as a bearer token. Each key works only for this connection."
      actions={<Button onClick={() => setNaming(true)}>New key</Button>}
    >
      {keys.isError ? (
        <ProblemBanner error={keys.error} />
      ) : keys.data && active.length === 0 ? (
        <EmptyState title="No keys yet" detail="Create a key for the bridge to call this bot with." />
      ) : (
        <Table label="Keys">
          <THead>
            <tr>
              <Th>Name</Th>
              <Th>Key</Th>
              <Th>Last used</Th>
              <Th>Created</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <tbody>
            {keys.isPending
              ? [0, 1].map((i) => (
                  <Tr key={i} aria-hidden="true">
                    {[0, 1, 2, 3, 4].map((col) => (
                      <Td key={col}>
                        <Skeleton className="h-3 w-12" />
                      </Td>
                    ))}
                  </Tr>
                ))
              : active.map((k) => (
                  <Tr key={k.id}>
                    <Td className="max-w-node">
                      <span className="block truncate font-medium">
                        <bdi>{k.name}</bdi>
                      </span>
                    </Td>
                    <Td>
                      <code dir="ltr" className="text-code-small text-secondary">
                        {k.prefix}_…
                      </code>
                    </Td>
                    <Td className="text-secondary">{k.lastUsedAt ? date.format(new Date(k.lastUsedAt)) : "Never"}</Td>
                    <Td className="text-secondary">{date.format(new Date(k.createdAt))}</Td>
                    <Td className="text-end">
                      <Button variant="ghost" size="compact" onClick={() => setRevoking(k)}>
                        Revoke
                      </Button>
                    </Td>
                  </Tr>
                ))}
          </tbody>
        </Table>
      )}
      <NameKeyDialog
        open={naming && !create.data}
        pending={create.isPending}
        error={create.error}
        onSubmit={(name) => create.mutate({ name })}
        onClose={() => {
          setNaming(false);
          create.reset();
        }}
      />
      <ShownOnceDialog
        open={create.data !== undefined}
        title="Copy the key"
        label="Bridge key"
        value={create.data?.key}
        onClose={() => {
          setNaming(false);
          create.reset();
        }}
      />
      <RevokeKeyDialog {...ids} apiKey={revoking} onClose={() => setRevoking(undefined)} />
    </Section>
  );
}

function NameKeyDialog({
  open,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean;
  pending: boolean;
  error: unknown;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const errors = fieldErrors(error);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setName("");
          onClose();
        }
      }}
      title="New key"
      footer={
        <>
          <Button size="large" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="key-form" variant="primary" size="large" disabled={pending}>
            Create key
          </Button>
        </>
      }
    >
      <form
        id="key-form"
        className="flex flex-col gap-6"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(name);
        }}
      >
        {error && Object.keys(errors).length === 0 ? <ProblemBanner error={error} /> : null}
        <Field label="Name" help="Where it is used, for example the production adapter." error={errors["name"]}>
          {(p) => <Input {...p} dir="auto" value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}

function RevokeKeyDialog({
  apiKey,
  onClose,
  ...ids
}: Ids & { apiKey: ConnectionKey | undefined; onClose: () => void }) {
  const revoke = useRevokeConnectionKey(ids.workspaceId, ids.botId, ids.connectionId);
  return (
    <Dialog
      open={apiKey !== undefined}
      onOpenChange={(o) => {
        if (!o) {
          revoke.reset();
          onClose();
        }
      }}
      title={`Revoke key "${apiKey?.name ?? ""}"?`}
      description="The bridge using it stops working at once. This cannot be undone."
      footer={
        <>
          <Button size="large" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="large"
            disabled={revoke.isPending}
            onClick={() => apiKey && revoke.mutate(apiKey.id, { onSuccess: onClose })}
          >
            Revoke key
          </Button>
        </>
      }
    >
      {revoke.isError ? <ProblemBanner error={revoke.error} /> : <span className="sr-only">Confirm revoking</span>}
    </Dialog>
  );
}

function SigningSecret({ connection: c, ...ids }: Ids & { connection: StudioConnection }) {
  const rotate = useRotateSecret(ids.workspaceId, ids.botId, ids.connectionId);
  const finish = useFinishRotation(ids.workspaceId, ids.botId, ids.connectionId);
  const rotating = c.signingSecrets.length > 1;
  return (
    <Section
      title="Signing secret"
      description="Every webhook is signed with it. Check the signature before trusting a webhook."
      actions={
        <span className="flex gap-4">
          {rotating ? (
            <Button disabled={finish.isPending} onClick={() => finish.mutate()}>
              Finish rotation
            </Button>
          ) : null}
          <Button disabled={rotate.isPending} onClick={() => rotate.mutate()}>
            Rotate
          </Button>
        </span>
      }
    >
      {rotate.isError ? <ProblemBanner error={rotate.error} /> : null}
      {finish.isError ? <ProblemBanner error={finish.error} /> : null}
      <ul className="flex flex-col gap-3">
        {c.signingSecrets.map((s, i) => (
          <li key={s.last4} className="flex items-center gap-4">
            <code dir="ltr" className="font-mono text-code-small text-primary">
              whsec_…{s.last4}
            </code>
            <span className="text-small text-secondary">
              {i === 0 ? "Current" : "Previous, still sent until you finish the rotation"}
            </span>
          </li>
        ))}
      </ul>
      {rotating ? (
        <p className="text-body text-secondary">
          Both secrets sign every webhook. Update your receiver to the new one, then finish the rotation.
        </p>
      ) : null}
      <ShownOnceDialog
        open={rotate.data !== undefined}
        title="Copy the new signing secret"
        label="Signing secret"
        value={rotate.data?.signingSecret}
        onClose={() => rotate.reset()}
      />
    </Section>
  );
}

function Examples() {
  const [language, setLanguage] = useState<(typeof SIGNATURE_CHECKS)[number]["id"]>("node");
  const check = SIGNATURE_CHECKS.find((s) => s.id === language) ?? SIGNATURE_CHECKS[0];
  return (
    <Section
      title="Examples"
      description="Send a message and get the reply in one call, then check webhook signatures."
    >
      <CodeBlock label="cURL" code={curlExample({ apiBaseUrl: window.location.origin })} />
      <div className="flex flex-col gap-4">
        <div role="tablist" aria-label="Signature check" className="flex gap-6 border-b border-hairline">
          {SIGNATURE_CHECKS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === language}
              className={tabClasses(s.id === language)}
              onClick={() => setLanguage(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <CodeBlock label={`Signature check in ${check.label}`} code={check.code} />
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Deliveries                                                          */
/* ------------------------------------------------------------------ */

function DeliveriesTab(ids: Ids) {
  const [filter, setFilter] = useState<"all" | "dead">("all");
  const deliveries = useDeliveries(ids.workspaceId, ids.botId, ids.connectionId, filter);
  const replay = useReplay(ids.workspaceId, ids.botId, ids.connectionId);
  return (
    <Section
      title="Deliveries"
      description="Each event sent to the webhook, with its latest attempt. Failed events can be sent again."
      actions={
        <div role="tablist" aria-label="Show" className="flex gap-6">
          {(["all", "dead"] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={f === filter}
              className={tabClasses(f === filter)}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "All" : "Failed"}
            </button>
          ))}
        </div>
      }
    >
      {replay.isError ? <ProblemBanner error={replay.error} /> : null}
      {deliveries.isError ? (
        <ProblemBanner error={deliveries.error} />
      ) : deliveries.data && deliveries.data.length === 0 ? (
        <EmptyState
          title={filter === "dead" ? "No failed events" : "Nothing sent yet"}
          detail={
            filter === "dead"
              ? "Events that could not be delivered after every retry appear here."
              : "Events appear here once the bot replies on this connection."
          }
        />
      ) : (
        <Table label="Deliveries">
          <THead>
            <tr>
              <Th>Event</Th>
              <Th>Conversation</Th>
              <Th>Status</Th>
              <Th>Attempts</Th>
              <Th>Response</Th>
              <Th>Problem</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <tbody>
            {deliveries.isPending
              ? [0, 1, 2].map((i) => (
                  <Tr key={i} aria-hidden="true">
                    {[0, 1, 2, 3, 4, 5, 6].map((col) => (
                      <Td key={col}>
                        <Skeleton className="h-3 w-11" />
                      </Td>
                    ))}
                  </Tr>
                ))
              : (deliveries.data ?? []).map((d) => (
                  <DeliveryRow
                    key={d.eventId}
                    delivery={d}
                    onReplay={() => replay.mutate(d.eventId)}
                    pending={replay.isPending}
                  />
                ))}
          </tbody>
        </Table>
      )}
    </Section>
  );
}

function DeliveryRow({
  delivery: d,
  onReplay,
  pending,
}: {
  delivery: BridgeDelivery;
  onReplay: () => void;
  pending: boolean;
}) {
  const status = deliveryStatus(d);
  const problem = describeError(d.error);
  return (
    <Tr>
      <Td>
        <code dir="ltr" className="font-mono text-code-small text-primary">
          {d.eventType}
        </code>
        {d.seq !== undefined ? <span className="ms-3 text-small text-tertiary">#{d.seq}</span> : null}
      </Td>
      <Td>
        <code dir="ltr" className="font-mono text-code-small text-secondary">
          {d.conversationId ? `${d.conversationId.slice(0, 10)}…` : "Test"}
        </code>
      </Td>
      <Td>
        <Badge tone={status.tone}>{status.label}</Badge>
      </Td>
      <Td className="text-secondary">
        {d.attempt}
        {d.status === "pending" && d.nextAttemptAt ? (
          <span className="block text-small text-tertiary">Next {dateTime.format(new Date(d.nextAttemptAt))}</span>
        ) : null}
      </Td>
      <Td className="text-secondary">{d.responseStatus ?? "—"}</Td>
      <Td className="max-w-node text-secondary">
        {problem ? (
          <span className="block truncate" title={problem.fix || problem.title}>
            {problem.title}
          </span>
        ) : (
          "—"
        )}
      </Td>
      <Td className="text-end">
        {canReplay(d) ? (
          <Button variant="ghost" size="compact" disabled={pending} onClick={onReplay}>
            Send again
          </Button>
        ) : null}
      </Td>
    </Tr>
  );
}

/* ------------------------------------------------------------------ */
/* Test                                                                */
/* ------------------------------------------------------------------ */

function TestTab({ connection: c, ...ids }: Ids & { connection: StudioConnection }) {
  const test = useTestWebhook(ids.workspaceId, ids.botId, ids.connectionId);
  const message = useTestMessage(ids.workspaceId, ids.botId, ids.connectionId);
  const [text, setText] = useState("");
  const result = test.data;
  const problem = describeError(result?.error);
  return (
    <div className="flex flex-col gap-10">
      <Section
        title="Test event"
        description="Sends a signed test event to the webhook and shows what it answered. Nothing is stored."
        actions={
          <Button disabled={test.isPending || !c.webhookUrl} onClick={() => test.mutate()}>
            Send test event
          </Button>
        }
      >
        {!c.webhookUrl ? (
          <p className="text-body text-secondary">Add a webhook URL on the Setup tab to send a test event.</p>
        ) : null}
        {test.isError ? <ProblemBanner error={test.error} /> : null}
        {result ? (
          result.delivered ? (
            <Banner tone="success" title="The webhook accepted the test event">
              It answered {result.statusCode} in {result.durationMs} ms.
            </Banner>
          ) : (
            <Banner tone="error" title={problem?.title ?? "The test event was not delivered"}>
              {result.statusCode ? `It answered ${result.statusCode}. ` : ""}
              {problem?.fix}
            </Banner>
          )
        ) : null}
      </Section>
      <Section
        title="Message as a user"
        description="Sends a message through this connection as a test user and shows the bot's reply. Not counted as live traffic."
      >
        <form
          className="flex max-w-inspector-max items-end gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) message.mutate(text.trim());
          }}
        >
          <div className="flex-1">
            <Field label="Message">
              {(p) => <Input {...p} dir="auto" value={text} onChange={(e) => setText(e.target.value)} />}
            </Field>
          </div>
          <Button type="submit" disabled={message.isPending || !text.trim()}>
            Send
          </Button>
        </form>
        {message.isError ? <ProblemBanner error={message.error} /> : null}
        {message.data ? <Replies result={message.data} /> : null}
      </Section>
    </div>
  );
}

function Replies({ result }: { result: TurnResult }) {
  if (result.messages.length === 0)
    return (
      <p className="text-body text-secondary">
        The bot did not reply{result.status === "handed_off" ? ": the conversation is with a person" : ""}.
      </p>
    );
  return (
    <ul className="flex flex-col gap-3" aria-label="Replies">
      {result.messages.map((m) => (
        <li
          key={m.id}
          className="max-w-inspector-max rounded-md bg-subtle px-5 py-3 text-content text-primary"
          dir="auto"
        >
          {m.payload.type === "text" ? m.payload.text : `[${m.payload.type}]`}
        </li>
      ))}
    </ul>
  );
}
