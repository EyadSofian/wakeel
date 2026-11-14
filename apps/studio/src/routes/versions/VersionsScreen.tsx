import { Link } from "@tanstack/react-router";
import type { VersionSummary } from "@wakeel/contracts";
import { Badge, Button, Dialog, EmptyState, Skeleton, Table, Td, THead, Th, Tr } from "@wakeel/ui";
import { useMemo, useState } from "react";
import { loadDraft } from "../../api/drafts";
import { useRestore, useRollback, useVersion, useVersions } from "../../api/versions";
import { useCanvasStore } from "../../canvas/context";
import { AppShell } from "../../shell/AppShell";
import { Page, PageHeader } from "../../shell/PageHeader";
import { ProblemBanner } from "../../shell/ProblemBanner";
import { Breadcrumb } from "../bot/BotCanvas";
import { useLoadState } from "../bot/BotLayout";
import { useDraftDefinition } from "./use-draft";

const dateTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

type Confirm = { kind: "rollback" | "restore"; version: VersionSummary };

/**
 * Versions (design system §5.8, task 7.5): every published version, newest first, with the live one
 * marked. Each can be compared with the draft, restored into the draft, or made live again.
 */
export function VersionsScreen({ workspaceId, botId }: { workspaceId: string; botId: string }) {
  const ready = useLoadState() === "ready";
  const versions = useVersions(workspaceId, botId);
  const [confirm, setConfirm] = useState<Confirm>();

  return (
    <AppShell
      title={<Breadcrumb workspaceId={workspaceId} ready={ready} page="Versions" />}
      active="Versions"
      workspaceId={workspaceId}
      botId={botId}
    >
      <Page>
        <PageHeader
          title="Versions"
          description="Each publish is kept. Live conversations run the live version; the emulator runs the draft."
        />
        {versions.isError ? (
          <div>
            <ProblemBanner error={versions.error} />
          </div>
        ) : versions.data && versions.data.length === 0 ? (
          <EmptyState
            title="No versions yet"
            detail="Publish the draft from the canvas to create version 1. Production connections answer once a version is live."
          />
        ) : (
          <Table label="Versions" fixed>
            <THead>
              <tr>
                <Th className="w-2/12">Version</Th>
                <Th className="w-4/12">Label</Th>
                <Th className="w-3/12">Published</Th>
                <Th className="w-3/12">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </THead>
            <tbody>
              {versions.isPending
                ? [0, 1, 2].map((i) => (
                    <Tr key={i} aria-hidden="true">
                      {[0, 1, 2, 3].map((c) => (
                        <Td key={c}>
                          <Skeleton className="h-3 w-12" />
                        </Td>
                      ))}
                    </Tr>
                  ))
                : (versions.data ?? []).map((v) => (
                    <VersionRow
                      key={v.id}
                      workspaceId={workspaceId}
                      botId={botId}
                      version={v}
                      onRollback={() => setConfirm({ kind: "rollback", version: v })}
                      onRestore={() => setConfirm({ kind: "restore", version: v })}
                    />
                  ))}
            </tbody>
          </Table>
        )}
      </Page>
      <RollbackDialog
        workspaceId={workspaceId}
        botId={botId}
        version={confirm?.kind === "rollback" ? confirm.version : undefined}
        onClose={() => setConfirm(undefined)}
      />
      <RestoreDialog
        workspaceId={workspaceId}
        botId={botId}
        version={confirm?.kind === "restore" ? confirm.version : undefined}
        onClose={() => setConfirm(undefined)}
      />
    </AppShell>
  );
}

function VersionRow({
  workspaceId,
  botId,
  version: v,
  onRollback,
  onRestore,
}: {
  workspaceId: string;
  botId: string;
  version: VersionSummary;
  onRollback: () => void;
  onRestore: () => void;
}) {
  return (
    <Tr>
      <Td>
        <span className="flex items-center gap-3">
          <span className="font-medium text-primary tabular-nums">v{v.number}</span>
          {v.live ? <Badge tone="success">Live</Badge> : null}
        </span>
      </Td>
      <Td>
        <span className="flex min-w-0 flex-col">
          <bdi className="truncate text-primary">{v.label}</bdi>
          {v.notes ? (
            <span dir="auto" className="truncate text-small text-secondary">
              {v.notes}
            </span>
          ) : null}
        </span>
      </Td>
      <Td className="text-secondary">
        <span className="flex min-w-0 flex-col">
          {v.createdBy ? <bdi className="truncate">{v.createdBy.name}</bdi> : null}
          <span className="text-small">{dateTime.format(new Date(v.createdAt))}</span>
        </span>
      </Td>
      <Td>
        <span className="flex items-center justify-end gap-3">
          <Link
            to="/w/$workspaceId/b/$botId/versions/$versionId"
            params={{ workspaceId, botId, versionId: v.id }}
            className="text-body font-medium text-accent hover:underline"
            aria-label={`Compare v${v.number} with the draft`}
          >
            Compare
          </Link>
          <Button size="compact" onClick={onRestore} aria-label={`Restore v${v.number} to the draft`}>
            Restore
          </Button>
          {v.live ? (
            // Keeps the column's buttons lined up with the rows that can roll back.
            <span aria-hidden="true" className="invisible">
              <Button size="compact" tabIndex={-1}>
                Roll back
              </Button>
            </span>
          ) : (
            <Button size="compact" onClick={onRollback} aria-label={`Roll back to v${v.number}`}>
              Roll back
            </Button>
          )}
        </span>
      </Td>
    </Tr>
  );
}

/** Rolling back says what happens to conversations in progress (§5.8). */
function RollbackDialog({
  workspaceId,
  botId,
  version,
  onClose,
}: {
  workspaceId: string;
  botId: string;
  version: VersionSummary | undefined;
  onClose: () => void;
}) {
  const rollback = useRollback(workspaceId, botId);
  const close = () => {
    rollback.reset();
    onClose();
  };
  return (
    <Dialog
      open={version !== undefined}
      onOpenChange={(o) => !o && close()}
      title={version ? `Roll back to v${version.number}?` : "Roll back"}
      description="It becomes the live version straight away. The draft does not change."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            disabled={rollback.isPending}
            onClick={() => version && rollback.mutate(version.id, { onSuccess: close })}
          >
            Roll back
          </Button>
        </>
      }
    >
      <p className="text-body text-secondary">
        Conversations in progress move to it at their next message. A conversation whose current step does not exist in
        it starts over, keeping the variables that still fit.
      </p>
      {rollback.isError ? <ProblemBanner error={rollback.error} /> : null}
    </Dialog>
  );
}

/** Restore replaces the draft and names the workflows it deletes (ADR-036 consequences). */
function RestoreDialog({
  workspaceId,
  botId,
  version,
  onClose,
}: {
  workspaceId: string;
  botId: string;
  version: VersionSummary | undefined;
  onClose: () => void;
}) {
  const restore = useRestore(workspaceId, botId);
  const store = useCanvasStore();
  const draft = useDraftDefinition();
  const full = useVersion(workspaceId, botId, version?.id);
  const removed = useMemo(() => {
    const keep = new Set(full.data?.definition.workflows.map((w) => w.id) ?? []);
    return full.data ? (draft?.workflows ?? []).filter((w) => !keep.has(w.id)).map((w) => w.name) : [];
  }, [full.data, draft]);
  const [reloading, setReloading] = useState(false);
  const close = () => {
    restore.reset();
    onClose();
  };
  const run = () => {
    if (!version) return;
    restore.mutate(version.id, {
      onSuccess: async () => {
        // The draft changed on the server; load it so the canvas and autosave carry on from it.
        setReloading(true);
        try {
          store.getState().load(await loadDraft(workspaceId, botId));
        } finally {
          setReloading(false);
          close();
        }
      },
    });
  };
  return (
    <Dialog
      open={version !== undefined}
      onOpenChange={(o) => !o && close()}
      title={version ? `Restore v${version.number} to the draft?` : "Restore"}
      description="The draft becomes exactly this version. Changes in the draft that are not in it are lost."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={restore.isPending || reloading || full.isPending} onClick={run}>
            {version ? `Restore v${version.number}` : "Restore"}
          </Button>
        </>
      }
    >
      {removed.length > 0 ? (
        <div className="flex flex-col gap-3">
          <p className="text-body text-primary">These workflows are not in it and will be deleted from the draft:</p>
          <ul className="flex flex-col gap-1 ps-6 text-body text-secondary">
            {removed.map((name) => (
              <li key={name} className="list-disc">
                <bdi>{name}</bdi>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-body text-secondary">
          The live version does not change. Publish afterwards to make it live.
        </p>
      )}
      {full.isError ? <ProblemBanner error={full.error} /> : null}
      {restore.isError ? <ProblemBanner error={restore.error} /> : null}
    </Dialog>
  );
}
