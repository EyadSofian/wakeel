import { Field, Select } from "@wakeel/ui";
import { useTableSchemas } from "../api/tables";
import { ProblemBanner } from "../shell/ProblemBanner";
import { useShell } from "../shell/shell-store";

export function useBotTables() {
  const { workspaceId, botId } = useShell();
  return useTableSchemas(workspaceId, botId);
}

export function TableSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const query = useBotTables();
  return (
    <>
      {query.isError && <ProblemBanner error={query.error} />}
      <Field label="Table">
        {(props) => (
          <Select
            {...props}
            value={value}
            disabled={query.isPending || query.isError}
            onChange={(e) => onChange(e.target.value)}
          >
            {!query.data?.some((table) => table.id === value) && (
              <option value={value}>{query.isPending ? "Loading tables" : "Unavailable table"}</option>
            )}
            {query.data?.map((table) => (
              <option key={table.id} value={table.id} dir="auto">
                {table.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </>
  );
}
