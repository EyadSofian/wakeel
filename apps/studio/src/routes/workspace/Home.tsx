import { Link, useNavigate } from "@tanstack/react-router";
import type { BotResponse } from "@wakeel/contracts";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  IconTile,
  Input,
  Skeleton,
  Table,
  Td,
  THead,
  Th,
  Tr,
} from "@wakeel/ui";
import { Bot, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { fieldErrors } from "../../api/client";
import { useBots, useCreateBot, useWorkspace } from "../../api/queries";
import { slugFrom } from "../../lib/slug";
import { AppShell } from "../../shell/AppShell";
import { Page, PageHeader } from "../../shell/PageHeader";
import { ProblemBanner } from "../../shell/ProblemBanner";
import { WorkspaceSwitcher } from "../../shell/WorkspaceSwitcher";

const COLUMNS = ["Name", "Status", "Conversations (7 d)", "Last published", "Updated"];

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
function ago(iso: string, now = Date.now()): string {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, "hour");
  return relative.format(Math.round(hours / 24), "day");
}

/**
 * Workspace home (design system §5.4): a table of bots. A row opens the bot's canvas. Status,
 * conversations and last published fill in with publishing (7.x) and conversations (10.x).
 */
export function Home({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);
  const bots = useBots(workspaceId);
  const [creating, setCreating] = useState(false);
  const canCreate = workspace.data?.permissions.includes("bot.create") ?? false;
  const error = workspace.error ?? bots.error;
  const loading = workspace.isPending || bots.isPending;

  const list = bots.data ?? [];
  const live = list.filter((b) => b.publishedVersionId !== null).length;
  const summary =
    loading || error || list.length === 0
      ? undefined
      : `${count(list.length, "bot", "bots")} · ${live} live · ${list.length - live} in draft`;

  return (
    <AppShell title={<WorkspaceSwitcher workspaceId={workspaceId} />} workspaceId={workspaceId} active="Home">
      <Page>
        <PageHeader
          title="Bots"
          description={summary ?? "Every bot in this workspace, with its status and last change."}
          actions={
            canCreate ? (
              <Button
                variant="primary"
                icon={<Plus className="size-icon" strokeWidth={1.75} aria-hidden="true" />}
                onClick={() => setCreating(true)}
              >
                New bot
              </Button>
            ) : null
          }
        />
        {error ? (
          <ProblemBanner error={error} />
        ) : !loading && list.length === 0 ? (
          <div className="rounded-lg border border-hairline bg-surface">
            <EmptyState
              title="No bots yet"
              detail={
                canCreate
                  ? "Use New bot to create one. It opens on a canvas with a Start node and an Autonomous node."
                  : "Bots built in this workspace appear here."
              }
            />
          </div>
        ) : (
          <Table label="Bots">
            <THead>
              <tr>
                {COLUMNS.map((c) => (
                  <Th key={c}>{c}</Th>
                ))}
              </tr>
            </THead>
            <tbody>
              {loading
                ? [0, 1, 2].map((i) => (
                    <Tr key={i} aria-hidden="true">
                      {COLUMNS.map((c, j) => (
                        <Td key={c}>
                          {j === 0 ? (
                            <span className="flex items-center gap-5">
                              <Skeleton className="size-tile rounded-sm" />
                              <Skeleton className="h-4 w-12" />
                            </span>
                          ) : (
                            <Skeleton className="h-3 w-11" />
                          )}
                        </Td>
                      ))}
                    </Tr>
                  ))
                : list.map((b) => <BotRow key={b.id} bot={b} workspaceId={workspaceId} />)}
            </tbody>
          </Table>
        )}
      </Page>
      <NewBotDialog workspaceId={workspaceId} open={creating} onOpenChange={setCreating} />
    </AppShell>
  );
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function BotRow({ bot, workspaceId }: { bot: BotResponse; workspaceId: string }) {
  return (
    <Tr>
      <Td className="max-w-node">
        <Link
          to="/w/$workspaceId/b/$botId"
          params={{ workspaceId, botId: bot.id }}
          className="flex min-w-0 items-center gap-5 rounded-sm"
        >
          <IconTile category="ai" icon={Bot} />
          <span className="flex min-w-0 flex-col">
            <span dir="auto" className="truncate font-medium text-primary">
              {bot.name}
            </span>
            <span className="truncate font-mono text-small text-tertiary">{bot.slug}</span>
          </span>
        </Link>
      </Td>
      <Td>
        {bot.publishedVersionId ? (
          <Badge tone="success">
            <span aria-hidden="true" className="size-status-dot rounded-full bg-success" />
            Live
          </Badge>
        ) : (
          <Badge>
            <span aria-hidden="true" className="size-status-dot rounded-full border border-strong" />
            Draft
          </Badge>
        )}
      </Td>
      <Td className="text-tertiary">—</Td>
      <Td className="text-tertiary">—</Td>
      <Td className="text-secondary">{ago(bot.updatedAt)}</Td>
    </Tr>
  );
}

function NewBotDialog({
  workspaceId,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const create = useCreateBot(workspaceId);
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const errors = fieldErrors(create.error);
  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      create.reset();
      setName("");
      setSlug("");
      setSlugEdited(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      { name, slug },
      { onSuccess: (bot) => void navigate({ to: "/w/$workspaceId/b/$botId", params: { workspaceId, botId: bot.id } }) },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="New bot"
      description="It starts with a Main workflow: Start, then an Autonomous node."
      footer={
        <>
          <Button size="large" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button type="submit" form="new-bot-form" variant="primary" size="large" disabled={create.isPending}>
            Create bot
          </Button>
        </>
      }
    >
      <form id="new-bot-form" className="flex flex-col gap-6" onSubmit={submit} noValidate>
        {create.isError && Object.keys(errors).length === 0 ? <ProblemBanner error={create.error} /> : null}
        <Field label="Name" error={errors["name"]}>
          {(p) => (
            <Input
              {...p}
              dir="auto"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugEdited) setSlug(slugFrom(e.target.value));
              }}
            />
          )}
        </Field>
        <Field label="Address" help="Lower-case letters, digits and dashes." error={errors["slug"]}>
          {(p) => (
            <Input
              {...p}
              dir="ltr"
              className="font-mono"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugEdited(true);
              }}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
