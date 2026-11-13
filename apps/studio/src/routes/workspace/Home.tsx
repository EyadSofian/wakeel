import { Link, useNavigate } from "@tanstack/react-router";
import type { BotResponse } from "@wakeel/contracts";
import { Button, Dialog, EmptyState, Field, Input, Skeleton, Table, Td, THead, Th, Tr } from "@wakeel/ui";
import { Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { fieldErrors } from "../../api/client";
import { useBots, useCreateBot, useWorkspace } from "../../api/queries";
import { slugFrom } from "../../lib/slug";
import { AppShell } from "../../shell/AppShell";
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

  return (
    <AppShell
      title={<WorkspaceSwitcher workspaceId={workspaceId} />}
      workspaceId={workspaceId}
      actions={
        canCreate ? (
          <Button
            variant="primary"
            icon={<Plus className="size-icon" strokeWidth={1.5} aria-hidden="true" />}
            onClick={() => setCreating(true)}
          >
            New bot
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col">
        <div className="flex h-topbar items-center border-b border-hairline px-5">
          <h1 className="text-heading text-primary">Bots</h1>
        </div>
        {error ? (
          <div className="px-5 py-6">
            <ProblemBanner error={error} />
          </div>
        ) : (
          <>
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
                        {COLUMNS.map((c) => (
                          <Td key={c}>
                            <Skeleton className="h-3 w-12" />
                          </Td>
                        ))}
                      </Tr>
                    ))
                  : (bots.data ?? []).map((b) => <BotRow key={b.id} bot={b} workspaceId={workspaceId} />)}
              </tbody>
            </Table>
            {!loading && bots.data?.length === 0 ? (
              <EmptyState
                title="No bots yet"
                detail={
                  canCreate
                    ? "Bots you build in this workspace appear here."
                    : "Bots built in this workspace appear here."
                }
              />
            ) : null}
          </>
        )}
      </div>
      <NewBotDialog workspaceId={workspaceId} open={creating} onOpenChange={setCreating} />
    </AppShell>
  );
}

function BotRow({ bot, workspaceId }: { bot: BotResponse; workspaceId: string }) {
  return (
    <Tr className="hover:bg-subtle">
      <Td className="max-w-node">
        <Link
          to="/w/$workspaceId/b/$botId"
          params={{ workspaceId, botId: bot.id }}
          dir="auto"
          className="block truncate font-medium text-primary hover:underline"
        >
          {bot.name}
        </Link>
      </Td>
      <Td className="text-secondary">
        {bot.publishedVersionId ? (
          <span className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="size-status-dot rounded-full bg-success" />
            Live
          </span>
        ) : (
          <span className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="size-status-dot rounded-full border border-strong" />
            Draft
          </span>
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
