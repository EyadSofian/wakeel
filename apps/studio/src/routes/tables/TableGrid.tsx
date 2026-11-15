import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { type Column, type Json, TableRowsPage, type TableSchemaResponse } from "@wakeel/contracts";
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
  Table,
  Td,
  Textarea,
  THead,
  Th,
  Tr,
} from "@wakeel/ui";
import { type FormEvent, type KeyboardEvent, useRef, useState } from "react";
import { ApiError, api, networkProblem } from "../../api/client";
import { ProblemBanner } from "../../shell/ProblemBanner";
import { TableFilter } from "./TableFilter";
import { displayCell, parseCell } from "./value";

type Schema = typeof TableSchemaResponse._output;
type Row = (typeof TableRowsPage._output)["data"][number];

export function TableGrid({
  table,
  path,
  edit,
  add,
}: {
  table: Schema;
  path: string;
  edit(column: Column): void;
  add(): void;
}) {
  const client = useQueryClient();
  const [filter, setFilter] = useState<{ search?: string; where?: Json }>({});
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [editing, setEditing] = useState<{ row: Row; column: Column; text: string }>();
  const [error, setError] = useState("");
  const cellButtons = useRef(new Map<string, HTMLButtonElement>());
  const [removing, setRemoving] = useState<Row>();
  const [importing, setImporting] = useState(false);
  const rowsPath = `${path}/rows`;
  const rows = useInfiniteQuery({
    queryKey: ["table-rows", path, table.revision, filter],
    queryFn: async ({ pageParam }) =>
      TableRowsPage.parse(
        await api("POST", `${rowsPath}/find`, {
          ...filter,
          limit: 50,
          ...(pageParam ? { cursor: pageParam } : {}),
        }),
      ),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const content = rows.data?.pages.flatMap((page) => page.data) ?? [];
  const count = rows.data?.pages[0]?.rowCount;
  const invalidate = () => client.invalidateQueries({ queryKey: ["table-rows", path] });
  const save = useMutation({
    mutationFn: async (input: { values: Record<string, Json>; row?: Row }) =>
      input.row
        ? api("PATCH", `${rowsPath}/${input.row.id}`, { values: input.values }, { "if-match": input.row.revision })
        : api("POST", rowsPath, { rows: [input.values] }),
    onSuccess: async () => {
      const active = editing;
      setEditing(undefined);
      setDraft(null);
      await invalidate();
      if (active) cellButtons.current.get(`${active.row.id}/${active.column.id}`)?.focus();
    },
  });
  const remove = useMutation({
    mutationFn: (row: Row) => api("DELETE", `${rowsPath}/${row.id}`, undefined, { "if-match": row.revision }),
    onSuccess: async () => {
      setRemoving(undefined);
      await invalidate();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (save.isPending) return;
    setError("");
    save.reset();
    try {
      if (editing) {
        save.mutate({ row: editing.row, values: { [editing.column.id]: parseCell(editing.column, editing.text) } });
      } else if (draft) {
        const values = Object.fromEntries(
          table.columns.map((column) => [column.id, parseCell(column, draft[column.id] ?? "")]),
        );
        save.mutate({ values });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Check the row values.");
    }
  }

  function addOrEdit(row: Row, column: Column, text = displayCell(row.data[column.id])) {
    setDraft(null);
    setError("");
    save.reset();
    setEditing({ row, column, text });
  }

  function onCellKey(event: KeyboardEvent<HTMLButtonElement>, row: Row, column: Column) {
    if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey || event.key === " ") return;
    event.preventDefault();
    addOrEdit(row, column, event.key);
  }

  function beginRow() {
    setEditing(undefined);
    setError("");
    save.reset();
    setDraft({});
  }

  const closeEdit = () => {
    const active = editing;
    setEditing(undefined);
    setDraft(null);
    if (active) requestAnimationFrame(() => cellButtons.current.get(`${active.row.id}/${active.column.id}`)?.focus());
  };

  const editForm = (inline = false) => (
    <form
      id={inline ? undefined : "table-row-edit"}
      className="flex flex-col items-start gap-4"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          closeEdit();
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(event);
      }}
    >
      {save.isError && <ProblemBanner error={save.error} />}
      {error && (
        <p role="alert" className="text-small text-error">
          {error}
        </p>
      )}
      {(editing ? [editing.column] : table.columns).map((column, index) => (
        <CellField
          key={column.id}
          column={column}
          focus={index === 0}
          value={editing?.text ?? draft?.[column.id] ?? ""}
          change={(text) => {
            if (editing) setEditing({ ...editing, text });
            else setDraft((current) => ({ ...current, [column.id]: text }));
          }}
        />
      ))}
      {!inline && !editing && (
        <div className="flex gap-3">
          <Button type="submit" variant="primary" disabled={save.isPending}>
            Save row
          </Button>
          <Button onClick={closeEdit}>Cancel</Button>
        </div>
      )}
      {inline && (
        <Button type="submit" size="compact" disabled={save.isPending}>
          Save
        </Button>
      )}
    </form>
  );

  return (
    <>
      <TableFilter key={table.revision} columns={table.columns} onApply={setFilter} />
      <div className="flex flex-wrap gap-3">
        <Button onClick={add} disabled={table.columns.length >= 50}>
          Add column
        </Button>
        <Button onClick={() => setImporting(true)}>Import CSV</Button>
      </div>
      {rows.isError && <ProblemBanner error={rows.error} />}
      {rows.isPending ? (
        <Skeleton className="h-12 w-full" />
      ) : (
        <div className="overflow-x-auto">
          <Table label="Table rows">
            <THead>
              <tr>
                {table.columns.map((column) => (
                  <Th key={column.id}>
                    <Button aria-label={`Column options for ${column.name}`} onClick={() => edit(column)}>
                      {column.name}
                    </Button>
                  </Th>
                ))}
                <Th>Actions</Th>
              </tr>
            </THead>
            <tbody>
              {content.map((row) => (
                <Tr key={row.id}>
                  {table.columns.map((column) => (
                    <Td key={column.id}>
                      {editing?.row.id === row.id && editing.column.id === column.id && column.type !== "json" ? (
                        editForm(true)
                      ) : (
                        <button
                          type="button"
                          ref={(button) => {
                            const key = `${row.id}/${column.id}`;
                            if (button) cellButtons.current.set(key, button);
                            else cellButtons.current.delete(key);
                          }}
                          dir="auto"
                          className="min-w-control max-w-xs truncate rounded-sm px-2 text-start"
                          aria-label={`Edit ${column.name}: ${displayCell(row.data[column.id]) || "Empty"}`}
                          onClick={() => addOrEdit(row, column)}
                          onKeyDown={(event) => onCellKey(event, row, column)}
                        >
                          {displayCell(row.data[column.id]) || "—"}
                        </button>
                      )}
                    </Td>
                  ))}
                  <Td>
                    <Button
                      onClick={() => {
                        remove.reset();
                        setRemoving(row);
                      }}
                    >
                      Delete row
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      {!rows.isPending && !rows.isError && !content.length && (
        <EmptyState title="No rows" detail="Add a row or change the filter." />
      )}
      {draft && editForm()}
      {editing?.column.type === "json" && (
        <Dialog
          open
          title={`Edit ${editing.column.name}`}
          onOpenChange={(open) => {
            if (!open) closeEdit();
          }}
          footer={
            <>
              <Button onClick={closeEdit}>Cancel</Button>
              <Button type="submit" form="table-row-edit" variant="primary" disabled={save.isPending}>
                Save
              </Button>
            </>
          }
        >
          {editForm()}
        </Dialog>
      )}
      <div className="flex flex-wrap items-center justify-between gap-4">
        {count !== undefined && <p className="text-small text-secondary">{count.toLocaleString()} of 100,000 rows</p>}
        {rows.hasNextPage && (
          <Button disabled={rows.isFetchingNextPage} onClick={() => void rows.fetchNextPage()}>
            Load more rows
          </Button>
        )}
        {!draft && !editing && <Button onClick={beginRow}>Add row</Button>}
      </div>
      {removing && (
        <Dialog
          open
          title="Delete row"
          onOpenChange={(open) => {
            if (!open) setRemoving(undefined);
          }}
          footer={
            <>
              <Button onClick={() => setRemoving(undefined)}>Cancel</Button>
              <Button variant="primary" disabled={remove.isPending} onClick={() => remove.mutate(removing)}>
                Delete row
              </Button>
            </>
          }
        >
          <p>Delete this row from the table.</p>
          {remove.isError && <ProblemBanner error={remove.error} />}
        </Dialog>
      )}
      {importing && <ImportDialog path={rowsPath} close={() => setImporting(false)} saved={invalidate} />}
    </>
  );
}

function CellField({
  column,
  value,
  change,
  focus,
}: {
  column: Column;
  value: string;
  change(text: string): void;
  focus: boolean;
}) {
  return (
    <Field label={column.name}>
      {(props) =>
        column.type === "boolean" || column.type === "enum" ? (
          <Select
            {...props}
            autoFocus={focus}
            value={value}
            required={column.required}
            onChange={(e) => change(e.target.value)}
          >
            <option value="">Empty</option>
            {(column.type === "boolean" ? ["true", "false"] : (column.enumValues ?? [])).map((option) => (
              <option key={option}>{option}</option>
            ))}
          </Select>
        ) : column.type === "json" ? (
          <Textarea
            {...props}
            dir="auto"
            rows={3}
            autoFocus={focus}
            value={value}
            onChange={(e) => change(e.target.value)}
          />
        ) : (
          <Input
            {...props}
            dir="auto"
            autoFocus={focus}
            value={value}
            required={column.required}
            onChange={(e) => change(e.target.value)}
          />
        )
      }
    </Field>
  );
}

function ImportDialog({ path, close, saved }: { path: string; close(): void; saved(): Promise<void> }) {
  const [file, setFile] = useState<File | undefined>();
  const mutation = useMutation({
    mutationFn: async (input: File) => {
      if (input.size > 1_000_000)
        throw new ApiError({
          ...networkProblem(),
          title: "The CSV is too large",
          fix: "Choose a CSV file under 1 MB.",
        });
      return api("POST", `${path}/import`, { csv: await input.text() });
    },
    onSuccess: async () => {
      await saved();
      close();
    },
  });
  return (
    <Dialog
      open
      title="Import CSV"
      onOpenChange={(open) => {
        if (!open) close();
      }}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!file || mutation.isPending}
            onClick={() => file && mutation.mutate(file)}
          >
            Import
          </Button>
        </>
      }
    >
      <Field label="CSV file" help="Use current column names in the header and include up to 500 rows.">
        {(props) => (
          <Input {...props} type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0])} />
        )}
      </Field>
      {mutation.isError && <ProblemBanner error={mutation.error} />}
    </Dialog>
  );
}
