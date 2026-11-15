import { Link } from "@tanstack/react-router";
import { BRIDGE_EVENT_TYPES, type StudioConnection } from "@wakeel/contracts";
import {
  Badge,
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
} from "@wakeel/ui";
import { Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { fieldErrors } from "../../api/client";
import { useConnections, useCreateConnection } from "../../api/connections";
import { AppShell } from "../../shell/AppShell";
import { Page, PageHeader } from "../../shell/PageHeader";
import { ProblemBanner } from "../../shell/ProblemBanner";
import { Breadcrumb } from "../bot/BotCanvas";
import { useLoadState } from "../bot/BotLayout";
import { connectionStatus, deliveryStatus, TARGET_LABELS, webhookHost } from "./model";
import { EventChecklist, ShownOnceDialog } from "./parts";

const dateTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

/**
 * Connections (design system §5.11, task 5.5): the bridges that talk to this bot, each with its
 * status and the result of its last webhook delivery.
 */
export function ConnectionsScreen({ workspaceId, botId }: { workspaceId: string; botId: string }) {
  const ready = useLoadState() === "ready";
  const connections = useConnections(workspaceId, botId);
  const [creating, setCreating] = useState(false);
  const icon = <Plus className="size-icon" strokeWidth={1.5} aria-hidden="true" />;

  return (
    <AppShell
      title={<Breadcrumb workspaceId={workspaceId} ready={ready} page="Connections" />}
      active="Connections"
      workspaceId={workspaceId}
      botId={botId}
    >
      <Page>
        <PageHeader
          title="Connections"
          description="Each bridge that sends messages to this bot and receives its replies by webhook."
          actions={
            <Button variant="primary" icon={icon} onClick={() => setCreating(true)}>
              New connection
            </Button>
          }
        />
        {connections.isError ? (
          <div>
            <ProblemBanner error={connections.error} />
          </div>
        ) : connections.data && connections.data.length === 0 ? (
          <EmptyState
            title="No connections yet"
            detail="Create one for each bridge, such as your Chatwoot adapter, to give it a key and a webhook."
          />
        ) : (
          <Table label="Connections">
            <THead>
              <tr>
                <Th>Name</Th>
                <Th>Runs</Th>
                <Th>Webhook</Th>
                <Th>Status</Th>
                <Th>Last delivery</Th>
              </tr>
            </THead>
            <tbody>
              {connections.isPending
                ? [0, 1, 2].map((i) => (
                    <Tr key={i} aria-hidden="true">
                      {[0, 1, 2, 3, 4].map((c) => (
                        <Td key={c}>
                          <Skeleton className="h-3 w-12" />
                        </Td>
                      ))}
                    </Tr>
                  ))
                : (connections.data ?? []).map((c) => (
                    <ConnectionRow key={c.id} workspaceId={workspaceId} botId={botId} connection={c} />
                  ))}
            </tbody>
          </Table>
        )}
      </Page>
      <CreateConnectionDialog
        workspaceId={workspaceId}
        botId={botId}
        open={creating}
        onClose={() => setCreating(false)}
      />
    </AppShell>
  );
}

function ConnectionRow({
  workspaceId,
  botId,
  connection: c,
}: {
  workspaceId: string;
  botId: string;
  connection: StudioConnection;
}) {
  const status = connectionStatus(c);
  const last = c.lastDelivery ? deliveryStatus(c.lastDelivery) : undefined;
  return (
    <Tr>
      <Td className="max-w-node">
        <Link
          to="/w/$workspaceId/b/$botId/connections/$connectionId"
          params={{ workspaceId, botId, connectionId: c.id }}
          className="block truncate font-medium text-primary hover:underline"
        >
          {/* bdi, not dir="auto": an Arabic name keeps its direction but stays at the column's start. */}
          <bdi>{c.name}</bdi>
        </Link>
      </Td>
      <Td className="text-secondary">{TARGET_LABELS[c.target]}</Td>
      <Td className="max-w-node">
        {c.webhookUrl ? (
          <span dir="ltr" className="block truncate font-mono text-code-small text-secondary">
            {webhookHost(c.webhookUrl)}
          </span>
        ) : (
          <span className="text-tertiary">None</span>
        )}
      </Td>
      <Td>
        <Badge tone={status.tone}>{status.label}</Badge>
      </Td>
      <Td className="text-secondary">
        {c.lastDelivery && last ? (
          <span className="flex items-center gap-3">
            <Badge tone={last.tone}>{last.label}</Badge>
            <span>{dateTime.format(new Date(c.lastDelivery.at))}</span>
          </span>
        ) : (
          "None yet"
        )}
      </Td>
    </Tr>
  );
}

function CreateConnectionDialog({
  workspaceId,
  botId,
  open,
  onClose,
}: {
  workspaceId: string;
  botId: string;
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateConnection(workspaceId, botId);
  const [name, setName] = useState("");
  const [target, setTarget] = useState<"production" | "draft">("production");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [events, setEvents] = useState<string[]>([...BRIDGE_EVENT_TYPES]);
  const errors = fieldErrors(create.error);

  const close = () => {
    create.reset();
    setName("");
    setTarget("production");
    setWebhookUrl("");
    setEvents([...BRIDGE_EVENT_TYPES]);
    onClose();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({
      name,
      target,
      subscribedEvents: events as typeof BRIDGE_EVENT_TYPES,
      ...(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}),
    } as Parameters<typeof create.mutate>[0]);
  };

  if (create.data) {
    return (
      <ShownOnceDialog
        open={open}
        title="Copy the signing secret"
        label="Signing secret"
        value={create.data.signingSecret}
        onClose={close}
      />
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="New connection"
      footer={
        <>
          <Button size="large" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="connection-form" variant="primary" size="large" disabled={create.isPending}>
            Create connection
          </Button>
        </>
      }
    >
      <form id="connection-form" className="flex flex-col gap-6" onSubmit={submit} noValidate>
        {create.isError && Object.keys(errors).length === 0 ? <ProblemBanner error={create.error} /> : null}
        <Field label="Name" help="The bridge it is for, for example Chatwoot." error={errors["name"]}>
          {(p) => <Input {...p} dir="auto" value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field
          label="Runs"
          help="Which version of the bot answers this connection's messages."
          error={errors["target"]}
        >
          {(p) => (
            <Select {...p} value={target} onChange={(e) => setTarget(e.target.value as "production" | "draft")}>
              <option value="production">{TARGET_LABELS.production}</option>
              <option value="draft">{TARGET_LABELS.draft}</option>
            </Select>
          )}
        </Field>
        <Field
          label="Webhook URL"
          help="Where the bot's replies and events are sent. Optional: without one, poll or wait for replies."
          error={errors["webhookUrl"]}
        >
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
      </form>
    </Dialog>
  );
}
