import type { Column, Json } from "@wakeel/contracts";
import { Button, Field, Input, Select } from "@wakeel/ui";
import { useState } from "react";
import { parseCell } from "./value";

const equality = [
  { id: "eq", label: "Equals" },
  { id: "ne", label: "Does not equal" },
  { id: "isNull", label: "Is empty" },
] as const;

function allowed(column: Column | undefined) {
  if (column?.type === "string" || column?.type === "enum")
    return [...equality, { id: "contains", label: "Contains" }, { id: "startsWith", label: "Starts with" }];
  if (column?.type === "number" || column?.type === "date")
    return [...equality, { id: "gt", label: "Greater than" }, { id: "lt", label: "Less than" }];
  return equality;
}

export function TableFilter({
  columns,
  onApply,
}: {
  columns: Column[];
  onApply(input: { search?: string; where?: Json }): void;
}) {
  const [search, setSearch] = useState("");
  const [columnId, setColumnId] = useState("");
  const [operator, setOperator] = useState("eq");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const column = columns.find((item) => item.id === columnId);
  return (
    <form
      className="flex flex-wrap items-end gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const where = column
            ? {
                [column.name]: {
                  [operator]: operator === "isNull" ? true : parseCell({ ...column, required: true }, value),
                },
              }
            : undefined;
          onApply({ ...(search.trim() ? { search: search.trim() } : {}), ...(where ? { where } : {}) });
          setError("");
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Check the filter value.");
        }
      }}
    >
      <Field label="Search rows">
        {(props) => (
          <Input {...props} dir="auto" maxLength={500} value={search} onChange={(e) => setSearch(e.target.value)} />
        )}
      </Field>
      <Field label="Filter column">
        {(props) => (
          <Select
            {...props}
            value={columnId}
            onChange={(e) => {
              setColumnId(e.target.value);
              setOperator("eq");
              setValue("");
            }}
          >
            <option value="">All rows</option>
            {columns.map((col) => (
              <option key={col.id} value={col.id}>
                {col.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {column && (
        <>
          <Field label="Operator">
            {(props) => (
              <Select {...props} value={operator} onChange={(e) => setOperator(e.target.value)}>
                {allowed(column).map((op) => (
                  <option key={op.id} value={op.id}>
                    {op.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {operator !== "isNull" && (
            <Field label="Filter value">
              {(props) => (
                <Input {...props} dir="auto" required value={value} onChange={(e) => setValue(e.target.value)} />
              )}
            </Field>
          )}
        </>
      )}
      <Button type="submit">Apply</Button>
      <Button
        onClick={() => {
          setColumnId("");
          setSearch("");
          setValue("");
          setError("");
          onApply({});
        }}
      >
        Clear
      </Button>
      {error && (
        <p className="text-small text-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
