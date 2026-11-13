import { Button, EmptyState, Skeleton, Table, Td, THead, Th, Tr } from "@wakeel/ui";
import { Plus } from "lucide-react";
import { useWorkspace } from "../../api/queries";
import { AppShell } from "../../shell/AppShell";
import { ProblemBanner } from "../../shell/ProblemBanner";
import { WorkspaceSwitcher } from "../../shell/WorkspaceSwitcher";

const COLUMNS = ["Name", "Status", "Conversations (7 d)", "Last published", "Updated"];

/**
 * Workspace home (design system §5.4): a table of bots, not a card grid. Bots arrive with task 2.1,
 * so for now the table is always empty and "New bot" is shown disabled with the reason.
 */
export function Home({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);
  const canCreate = workspace.data?.permissions.includes("bot.create") ?? false;
  return (
    <AppShell
      title={<WorkspaceSwitcher workspaceId={workspaceId} />}
      workspaceId={workspaceId}
      actions={
        <Button
          variant="primary"
          icon={<Plus className="size-icon" strokeWidth={1.5} aria-hidden="true" />}
          disabled
          aria-describedby="new-bot-note"
        >
          New bot
        </Button>
      }
    >
      <div className="flex flex-col">
        <div className="flex h-topbar items-center border-b border-hairline px-5">
          <h1 className="text-heading text-primary">Bots</h1>
        </div>
        {workspace.isError ? (
          <div className="px-5 py-6">
            <ProblemBanner error={workspace.error} />
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
                {workspace.isPending
                  ? [0, 1, 2].map((i) => (
                      <Tr key={i} aria-hidden="true">
                        {COLUMNS.map((c) => (
                          <Td key={c}>
                            <Skeleton className="h-3 w-12" />
                          </Td>
                        ))}
                      </Tr>
                    ))
                  : null}
              </tbody>
            </Table>
            {workspace.isPending ? null : (
              <EmptyState
                title="No bots yet"
                detail={
                  canCreate
                    ? "Bots you build in this workspace appear here. Creating bots arrives with the canvas."
                    : "Bots built in this workspace appear here."
                }
              />
            )}
            <p id="new-bot-note" className="sr-only">
              Creating bots arrives with the canvas.
            </p>
          </>
        )}
      </div>
    </AppShell>
  );
}
