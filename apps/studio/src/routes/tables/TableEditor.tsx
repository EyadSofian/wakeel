import { useMutation } from "@tanstack/react-query";
import { type Column, ColumnType, newElementId, type TableSchema } from "@wakeel/contracts";
import { Button, Dialog, Field, Input, Select, Textarea } from "@wakeel/ui";
import { useState } from "react";
import { api } from "../../api/client";
import { ProblemBanner } from "../../shell/ProblemBanner";

type Definition = Omit<TableSchema, "id">;
type Current = TableSchema & { revision: string };
const newColumn = (): Column => ({
  id: newElementId("col"),
  name: "",
  type: "string",
  required: false,
  unique: false,
  searchable: false,
});
const identifier = "[A-Za-z_][A-Za-z0-9_]{0,47}";

export function TableEditor({
  path,
  table,
  column,
  close,
  saved,
}: {
  path: string;
  table?: Current;
  column?: Column;
  close(): void;
  saved(): void;
}) {
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [name, setName] = useState(table?.name ?? "");
  const [draft, setDraft] = useState(column ?? newColumn);
  const [choices, setChoices] = useState(column?.enumValues?.join("\n") ?? "");
  const change = (patch: Partial<Column>) => setDraft((previous) => ({ ...previous, ...patch }));
  const mutation = useMutation({
    mutationFn: async (remove: boolean) => {
      const { enumValues: _old, ...rest } = draft;
      const next =
        draft.type === "enum"
          ? {
              ...rest,
              enumValues: choices
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            }
          : rest;
      const columns = table
        ? column
          ? table.columns.flatMap((old) => (old.id === column.id ? (remove ? [] : [next]) : [old]))
          : [...table.columns, next]
        : [next];
      const body: Definition = { name, columns };
      return table
        ? api("PATCH", `${path}/${table.id}`, body, { "if-match": table.revision })
        : api("POST", path, body);
    },
    onSuccess: saved,
  });
  const title = !table ? "New table" : column ? "Edit column" : "Add column";
  return (
    <Dialog
      open
      title={title}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      footer={
        <>
          {column && (
            <Button
              onClick={() => {
                if (confirmRemoval) mutation.mutate(true);
                else setConfirmRemoval(true);
              }}
              disabled={mutation.isPending || table?.columns.length === 1}
            >
              {confirmRemoval ? "Confirm delete" : "Delete column"}
            </Button>
          )}
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" type="submit" form="table-editor" disabled={mutation.isPending}>
            {table ? "Save" : "Create table"}
          </Button>
        </>
      }
    >
      <form
        id="table-editor"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate(false);
        }}
      >
        {mutation.isError && <ProblemBanner error={mutation.error} />}
        {confirmRemoval && <p role="status">Deleting the column removes its values from every row.</p>}
        {!table && (
          <Field label="Table name">
            {(props) => (
              <Input
                {...props}
                pattern={identifier}
                maxLength={48}
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
        )}
        <Field label="Column name">
          {(props) => (
            <Input
              {...props}
              pattern={identifier}
              maxLength={48}
              required
              value={draft.name}
              onChange={(event) => change({ name: event.target.value })}
            />
          )}
        </Field>
        <Field label="Type">
          {(props) => (
            <Select
              {...props}
              value={draft.type}
              onChange={(event) => change({ type: ColumnType.parse(event.target.value) })}
            >
              {ColumnType.options.map((type) => (
                <option key={type} value={type}>
                  {type.charAt(0).toUpperCase() + type.slice(1)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {draft.type === "enum" && (
          <Field label="Options" help="Enter one option per line.">
            {(props) => (
              <Textarea
                {...props}
                rows={3}
                dir="auto"
                required
                value={choices}
                onChange={(event) => setChoices(event.target.value)}
              />
            )}
          </Field>
        )}
        <div className="flex flex-wrap gap-4">
          {(["required", "unique", "searchable"] as const).map((flag) => (
            <label key={flag} className="flex items-center gap-2 text-small">
              <input type="checkbox" checked={draft[flag]} onChange={(e) => change({ [flag]: e.target.checked })} />
              {flag.charAt(0).toUpperCase() + flag.slice(1)}
            </label>
          ))}
        </div>
      </form>
    </Dialog>
  );
}
