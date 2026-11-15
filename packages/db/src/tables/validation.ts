import { AppError, type Column, Json, TABLE_LIMITS, TableSchema } from "@wakeel/contracts";
import { z } from "zod";

const row = z.record(z.string(), Json);
const date = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

export function checkedSchema(raw: unknown): TableSchema {
  const schema = TableSchema.parse(raw);
  if (
    new Set(schema.columns.map((column) => column.id)).size !== schema.columns.length ||
    new Set(schema.columns.map((column) => column.name)).size !== schema.columns.length
  ) {
    throw new AppError("validation_failed", {}, { detail: "Each column needs a distinct name and ID." });
  }
  for (const column of schema.columns) {
    const values = column.enumValues ?? [];
    if (column.type === "enum" && (values.length === 0 || new Set(values).size !== values.length)) {
      throw new AppError("validation_failed", {}, { detail: `Give ${column.name} distinct options.` });
    }
  }
  return schema;
}

export function canonicalValue(column: Column, value: Json): Json {
  switch (column.type) {
    case "json":
      return value;
    case "string":
    case "number":
    case "boolean":
      if (typeof value === column.type) return value;
      break;
    case "enum":
      if (typeof value === "string" && column.enumValues?.includes(value)) return value;
      break;
    case "date":
      if (date.safeParse(value).success && typeof value === "string") return new Date(value).toISOString();
      break;
  }
  throw new AppError("table_row_invalid", { message: `Enter a ${column.type} value for ${column.name}` });
}

export function validateRow(columns: Column[], raw: unknown): Record<string, Json> {
  const tooLarge = () =>
    new AppError("table_row_invalid", { message: `the row must fit in ${TABLE_LIMITS.rowBytes} bytes` });
  let serialised: string | undefined;
  let parsed: ReturnType<typeof row.safeParse>;
  try {
    serialised = JSON.stringify(raw);
    if (serialised && Buffer.byteLength(serialised) > TABLE_LIMITS.rowBytes) throw tooLarge();
    parsed = row.safeParse(raw);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("table_row_invalid", { message: "use a JSON object with bounded nesting" });
  }
  if (!parsed.success) throw new AppError("table_row_invalid", { message: "use a JSON object" });

  const allowed = new Map(columns.map((column) => [column.id, column]));
  const values: Record<string, Json> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    const column = allowed.get(key);
    if (!column) throw new AppError("table_row_invalid", { message: "a column ID is no longer in this table" });
    values[key] = value === null ? null : canonicalValue(column, value);
  }
  for (const column of columns) {
    if (column.required && values[column.id] == null) {
      throw new AppError("table_row_invalid", { message: `Enter a value for ${column.name}` });
    }
  }
  if (Buffer.byteLength(JSON.stringify(values)) > TABLE_LIMITS.rowBytes) throw tooLarge();
  return values;
}
