import { Link } from "@tanstack/react-router";
import { type BotDefinition, diffDefinitions } from "@wakeel/contracts";
import { Badge, EmptyState, Select, Skeleton, Table, Td, THead, Th, Tr } from "@wakeel/ui";
import { ArrowLeft } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useVersion, useVersions } from "../../api/versions";
import { AppShell } from "../../shell/AppShell";
import { Page, PageHeader } from "../../shell/PageHeader";
import { ProblemBanner } from "../../shell/ProblemBanner";
import { Breadcrumb } from "../bot/BotCanvas";
import { useLoadState } from "../bot/BotLayout";
import { CHANGE_LABELS, CHANGE_TONES, type DiffRow, diffRows } from "./model";
import { useDraftDefinition } from "./use-draft";

const INDENT = ["ps-0", "ps-6", "ps-9", "ps-11"] as const;

/**
 * Compare (design system §5.8, task 7.5): a version against the draft or another version, as a
 * structural diff by workflow → node → card → field. Canvas moves are not changes (7.4).
 */
export function CompareScreen({
  workspaceId,
  botId,
  versionId,
}: {
  workspaceId: string;
  botId: string;
  versionId: string;
}) {
  const ready = useLoadState() === "ready";
  const selectId = useId();
  const versions = useVersions(workspaceId, botId);
  const base = useVersion(workspaceId, botId, versionId);
  const [against, setAgainst] = useState<string>("draft");
  const other = useVersion(workspaceId, botId, against === "draft" ? undefined : against);
  const draft = useDraftDefinition();
  const after: BotDefinition | undefined = against === "draft" ? draft : other.data?.definition;
  const before = base.data?.definition;
  const rows = useMemo(
    () => (before && after ? diffRows(diffDefinitions(before, after), before, after) : undefined),
    [before, after],
  );
  const label = (n: number | undefined) => (n === undefined ? "this version" : `v${n}`);
  const otherLabel = against === "draft" ? "the draft" : label(versions.data?.find((v) => v.id === against)?.number);
  const error = base.error ?? other.error ?? versions.error;

  return (
    <AppShell
      title={<Breadcrumb workspaceId={workspaceId} ready={ready} page="Versions" />}
      active="Versions"
      workspaceId={workspaceId}
      botId={botId}
    >
      <Page>
        <Link
          to="/w/$workspaceId/b/$botId/versions"
          params={{ workspaceId, botId }}
          className="flex items-center gap-2 self-start text-small text-secondary hover:text-primary"
        >
          <ArrowLeft className="size-icon-sm" strokeWidth={1.75} aria-hidden="true" />
          Versions
        </Link>
        <PageHeader
          title={`Compare ${label(base.data?.number)}`}
          description={`What changes from ${label(base.data?.number)} to ${otherLabel}. Moving nodes on the canvas is not a change.`}
          actions={
            <div className="flex items-center gap-4">
              <label htmlFor={selectId} className="text-small font-medium text-primary">
                Compare with
              </label>
              <Select id={selectId} value={against} onChange={(e) => setAgainst(e.target.value)}>
                <option value="draft">The draft</option>
                {(versions.data ?? [])
                  .filter((v) => v.id !== versionId)
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {`v${v.number}${v.live ? " (live)" : ""}`}
                    </option>
                  ))}
              </Select>
            </div>
          }
        />
        {error ? (
          <div>
            <ProblemBanner error={error} />
          </div>
        ) : !rows ? (
          <div className="flex flex-col gap-4" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-control w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No changes"
            detail={`${otherLabel[0]?.toUpperCase()}${otherLabel.slice(1)} behaves exactly like ${label(base.data?.number)}.`}
          />
        ) : (
          <Table label="Changes" fixed>
            <THead>
              <tr>
                <Th className="w-4/12">What</Th>
                <Th className="w-4/12">{label(base.data?.number)}</Th>
                <Th className="w-4/12">{otherLabel[0]?.toUpperCase() + otherLabel.slice(1)}</Th>
              </tr>
            </THead>
            <tbody>
              {rows.map((r) => (
                <ChangeRow key={r.key} row={r} />
              ))}
            </tbody>
          </Table>
        )}
      </Page>
    </AppShell>
  );
}

function ChangeRow({ row }: { row: DiffRow }) {
  const heading = row.kind !== "field";
  return (
    <Tr>
      <Td className={INDENT[row.depth]}>
        <span className="flex min-w-0 items-center gap-3">
          {heading ? (
            <>
              <bdi className="truncate font-medium text-primary">{row.title}</bdi>
              {row.detail ? <span className="shrink-0 text-small text-secondary">{row.detail}</span> : null}
              <span className="shrink-0">
                <Badge tone={CHANGE_TONES[row.change]}>{CHANGE_LABELS[row.change]}</Badge>
              </span>
            </>
          ) : (
            <span dir="ltr" className="truncate font-mono text-code-small text-secondary">
              {row.title}
            </span>
          )}
        </span>
      </Td>
      <Td>
        <Value text={row.before} />
      </Td>
      <Td>
        <Value text={row.after} />
      </Td>
    </Tr>
  );
}

/** Builder, bot or model text: kept in its own direction, wrapped, never cut mid-word. */
function Value({ text }: { text: string | undefined }) {
  if (text === undefined) return <span className="text-tertiary">None</span>;
  if (text === "") return <span className="text-tertiary">Empty</span>;
  return (
    <span dir="auto" className="line-clamp-4 whitespace-pre-wrap break-words text-body text-primary">
      {text}
    </span>
  );
}
