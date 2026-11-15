import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type Column, TableSchemaResponse } from "@wakeel/contracts";
import { Button, Dialog, EmptyState, Skeleton, Table, Td, THead, Th, Tr } from "@wakeel/ui";
import { useState } from "react";
import { api } from "../../api/client";
import { tablePath, useTableSchemas } from "../../api/tables";
import { AppShell } from "../../shell/AppShell";
import { Page, PageHeader } from "../../shell/PageHeader";
import { ProblemBanner } from "../../shell/ProblemBanner";
import { Breadcrumb } from "../bot/BotCanvas";
import { useLoadState } from "../bot/BotLayout";
import { TableEditor } from "./TableEditor";
import { TableGrid } from "./TableGrid";

const listRoute = "/w/$workspaceId/b/$botId/tables";
const detailRoute = "/w/$workspaceId/b/$botId/tables/$tableId";

export function TablesScreen({
  workspaceId,
  botId,
  tableId,
}: {
  workspaceId: string;
  botId: string;
  tableId?: string;
}) {
  const ready = useLoadState() === "ready";
  return (
    <AppShell
      title={<Breadcrumb workspaceId={workspaceId} ready={ready} page="Tables" />}
      workspaceId={workspaceId}
      botId={botId}
      active="Tables"
    >
      <Page>
        {tableId ? (
          <TableDetail key={tableId} workspaceId={workspaceId} botId={botId} id={tableId} />
        ) : (
          <TablesList workspaceId={workspaceId} botId={botId} />
        )}
      </Page>
    </AppShell>
  );
}

function TablesList({ workspaceId, botId }: { workspaceId: string; botId: string }) {
  const list = useTableSchemas(workspaceId, botId);
  const [creating, setCreating] = useState(false);
  const client = useQueryClient();
  return (
    <>
      <PageHeader
        title="Tables"
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New table
          </Button>
        }
      />
      {list.isPending ? (
        <Skeleton className="h-12 w-full" />
      ) : list.isError ? (
        <ProblemBanner error={list.error} />
      ) : !list.data.length ? (
        <EmptyState title="No tables yet" detail="Create a table to store structured data for this bot." />
      ) : (
        <Table label="Tables">
          <THead>
            <tr>
              <Th>Name</Th>
              <Th>Columns</Th>
            </tr>
          </THead>
          <tbody>
            {list.data.map((table) => (
              <Tr key={table.id}>
                <Td>
                  <Link className="text-accent" to={detailRoute} params={{ workspaceId, botId, tableId: table.id }}>
                    {table.name}
                  </Link>
                </Td>
                <Td>{table.columns.length}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      {creating && (
        <TableEditor
          path={tablePath(workspaceId, botId)}
          close={() => setCreating(false)}
          saved={() => {
            setCreating(false);
            void client.invalidateQueries({ queryKey: ["tables", workspaceId, botId] });
          }}
        />
      )}
    </>
  );
}

function TableDetail({ workspaceId, botId, id }: { workspaceId: string; botId: string; id: string }) {
  const root = tablePath(workspaceId, botId);
  const path = `${root}/${id}`;
  const client = useQueryClient();
  const navigate = useNavigate();
  const key = ["table", workspaceId, botId, id];
  const query = useQuery({ queryKey: key, queryFn: async () => TableSchemaResponse.parse(await api("GET", path)) });
  const [field, setField] = useState<Column | "new">();
  const [deleting, setDeleting] = useState(false);
  const remove = useMutation({
    mutationFn: (revision: string) => api("DELETE", path, undefined, { "if-match": revision }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["tables", workspaceId, botId] });
      await navigate({ to: listRoute, params: { workspaceId, botId } });
    },
  });
  const table = query.data;
  return (
    <>
      <Link to={listRoute} params={{ workspaceId, botId }} className="text-accent">
        All tables
      </Link>
      {query.isPending ? (
        <Skeleton className="h-12 w-full" />
      ) : query.isError ? (
        <ProblemBanner error={query.error} />
      ) : (
        table && (
          <>
            <PageHeader title={table.name} actions={<Button onClick={() => setDeleting(true)}>Delete table</Button>} />
            <TableGrid key={table.revision} path={path} table={table} edit={setField} add={() => setField("new")} />
            {field && (
              <TableEditor
                path={root}
                table={table}
                {...(field === "new" ? {} : { column: field })}
                close={() => setField(undefined)}
                saved={() => {
                  setField(undefined);
                  void client.invalidateQueries({ queryKey: key });
                  void client.invalidateQueries({ queryKey: ["tables", workspaceId, botId] });
                }}
              />
            )}
            {deleting && (
              <Dialog
                open
                title="Delete table"
                onOpenChange={(open) => {
                  if (!open) setDeleting(false);
                }}
                footer={
                  <>
                    <Button onClick={() => setDeleting(false)}>Cancel</Button>
                    <Button variant="primary" disabled={remove.isPending} onClick={() => remove.mutate(table.revision)}>
                      Delete table
                    </Button>
                  </>
                }
              >
                <p>Delete this table and its rows. A published bot that uses the table prevents deletion.</p>
                {remove.isError && <ProblemBanner error={remove.error} />}
              </Dialog>
            )}
          </>
        )
      )}
    </>
  );
}
