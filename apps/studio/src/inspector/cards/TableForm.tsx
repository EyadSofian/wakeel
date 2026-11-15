import { TableCard, TableOperation } from "@wakeel/contracts";
import { Field, Input, Select, Textarea } from "@wakeel/ui";
import { FieldShell, StringField, useDraft } from "../fields";
import { TableSelect, useBotTables } from "../TableFields";
import { type CardFormProps, useWritable } from "./CardForms";

export const TABLE_OPERATION_LABELS: Record<TableOperation, string> = {
  find: "Find rows",
  get: "Get first row",
  insert: "Insert row",
  update: "Update first row",
  upsert: "Upsert row",
  delete: "Delete matching rows",
};

export function TableForm({ card, node, path, commit }: CardFormProps<"table">) {
  const table = useBotTables().data?.find((table) => table.id === card.tableId);
  const read = card.operation === "find" || card.operation === "get";
  const matches = card.operation === "update" || card.operation === "delete";
  const takesValues = card.operation === "insert" || card.operation === "upsert" || card.operation === "update";
  const outputType = card.operation === "find" ? "array" : "object";
  const variables = useWritable().filter((v) => v.type === outputType || v.type === "any" || v.id === card.into);
  return (
    <>
      <TableSelect
        value={card.tableId}
        onChange={(tableId) => {
          const { where: _where, values: _values, upsertOn: _key, search: _search, ...rest } = card;
          commit({ ...rest, tableId, sort: [] });
        }}
      />
      <Field label="Operation">
        {(props) => (
          <Select
            {...props}
            value={card.operation}
            onChange={(e) => {
              const operation = TableOperation.parse(e.target.value);
              const { where: _where, values: _values, upsertOn: _key, search: _search, into: _into, ...rest } = card;
              commit({ ...rest, operation, sort: [] });
            }}
          >
            {TableOperation.options.map((op) => (
              <option key={op} value={op}>
                {TABLE_OPERATION_LABELS[op]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {!read && <p className="text-small text-secondary">Table writes run in live conversations only.</p>}
      {(read || matches) && (
        <JsonField
          key={`${card.tableId}:${card.operation}:where`}
          label="Filter"
          help='Use column names and expressions, for example {"status":{"eq":"event.text"}}.'
          value={card.where}
          parse={(value) => TableCard.shape.where.parse(value)}
          required={matches}
          onCommit={(where) => {
            const { where: _where, ...rest } = card;
            commit(where ? { ...rest, where } : rest);
          }}
        />
      )}
      {read && (
        <>
          <StringField
            label="Search"
            value={card.search ?? ""}
            check="text"
            path={`${path}.search`}
            node={node}
            onCommit={(search) => {
              const { search: _search, ...rest } = card;
              commit(search ? { ...rest, search } : rest);
            }}
          />
          <JsonField
            label="Sort"
            help='Use up to three columns, for example [{"column":"status","direction":"asc"}].'
            key={`${card.tableId}:${card.operation}:sort`}
            value={card.sort.length ? card.sort : undefined}
            parse={(value) => TableCard.shape.sort.parse(value)}
            onCommit={(sort) => commit({ ...card, sort: sort ?? [] })}
          />
          {card.operation === "find" && (
            <Field label="Maximum rows">
              {(props) => (
                <Input
                  {...props}
                  key={card.limit}
                  type="number"
                  min={1}
                  max={500}
                  defaultValue={card.limit}
                  onBlur={(e) => {
                    const value = TableCard.shape.limit.safeParse(e.currentTarget.valueAsNumber);
                    if (value.success && value.data !== card.limit) commit({ ...card, limit: value.data });
                    else e.currentTarget.value = String(card.limit);
                  }}
                />
              )}
            </Field>
          )}
        </>
      )}
      {takesValues && (
        <JsonField
          label="Values"
          help='Use column names and expressions, for example {"status":"event.text"}.'
          key={`${card.tableId}:${card.operation}:values`}
          value={card.values}
          parse={(value) => TableCard.shape.values.parse(value)}
          required
          onCommit={(values) => {
            if (values) commit({ ...card, values });
          }}
        />
      )}
      {card.operation === "upsert" && (
        <Field label="Unique column" help="Matches the existing row by this column.">
          {(props) => (
            <Select
              {...props}
              value={card.upsertOn ?? ""}
              onChange={(e) => {
                const { upsertOn: _key, ...rest } = card;
                const upsertOn = e.target.value;
                commit(upsertOn ? { ...rest, upsertOn } : rest);
              }}
            >
              <option value="">Choose a unique column</option>
              {table?.columns
                .filter((column) => column.unique)
                .map((column) => (
                  <option key={column.id} value={column.name} dir="auto">
                    {column.name}
                  </option>
                ))}
              {card.upsertOn && !table?.columns.some((column) => column.unique && column.name === card.upsertOn) && (
                <option value={card.upsertOn} dir="auto">
                  {card.upsertOn}
                </option>
              )}
            </Select>
          )}
        </Field>
      )}
      {card.operation !== "delete" && (
        <Field label="Save result to">
          {(props) => (
            <Select
              {...props}
              value={card.into ?? ""}
              onChange={(e) => {
                const { into: _into, ...rest } = card;
                const into = e.target.value;
                commit(into ? { ...rest, into } : rest);
              }}
            >
              <option value="">Do not save</option>
              {variables.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.path}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
    </>
  );
}

function JsonField<T>({
  label,
  help,
  value,
  parse,
  onCommit,
  required = false,
}: {
  label: string;
  help: string;
  value: T | undefined;
  parse: (value: unknown) => T;
  onCommit: (value: T | undefined) => void;
  required?: boolean;
}) {
  const shown = value === undefined ? "" : JSON.stringify(value, null, 2);
  const [draft, setDraft] = useDraft(shown);
  let parsed: T | undefined;
  let problem: { message: string; fix: string } | undefined;
  if (draft.trim()) {
    try {
      parsed = parse(JSON.parse(draft));
    } catch {
      problem = { message: `${label} has an invalid format.`, fix: "Check the JSON against the example." };
    }
  } else if (required) {
    problem = { message: `${label} is required.`, fix: "Enter JSON using the example." };
  }
  return (
    <FieldShell label={label} help={help} problem={problem}>
      {({ invalid, ...props }) => (
        <Textarea
          {...props}
          dir="ltr"
          value={draft}
          spellCheck={false}
          aria-invalid={invalid || undefined}
          className="font-mono text-code-small"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (!problem && draft !== shown) onCommit(parsed);
          }}
        />
      )}
    </FieldShell>
  );
}
