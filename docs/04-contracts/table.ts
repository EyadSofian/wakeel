import { z } from "zod";
import { ColumnId, Expression, Identifier, Json, TableId } from "./common";

export const ColumnType = z.enum(["string", "number", "boolean", "date", "enum", "json"]);
export type ColumnType = z.infer<typeof ColumnType>;

export const Column = z.object({
  id: ColumnId,
  name: Identifier,
  type: ColumnType,
  enumValues: z.array(z.string().min(1)).max(100).optional(),
  required: z.boolean().default(false),
  unique: z.boolean().default(false),
  /** Included in full-text search over the table. */
  searchable: z.boolean().default(false),
  description: z.string().max(300).optional(),
});
export type Column = z.infer<typeof Column>;

export const TableSchema = z.object({
  id: TableId,
  name: Identifier,
  description: z.string().max(500).optional(),
  columns: z.array(Column).min(1).max(50),
});
export type TableSchema = z.infer<typeof TableSchema>;

/**
 * Filter AST. Compiled to parameterised SQL; never interpolated.
 * `V` is the value type: `Json` at the API and in code, `Expression` inside card definitions.
 */
const ops = <V extends z.ZodType>(value: V) =>
  z
    .object({
      eq: value,
      ne: value,
      gt: value,
      gte: value,
      lt: value,
      lte: value,
      in: z.array(value).max(200),
      contains: value,
      startsWith: value,
      isNull: z.boolean(),
    })
    .partial()
    .refine((o) => Object.keys(o).length === 1, "Use exactly one operator per column condition");

export type Filter<V = Json> =
  | { and: Filter<V>[] }
  | { or: Filter<V>[] }
  | { not: Filter<V> }
  | { [column: string]: Partial<Record<"eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | "startsWith", V>> & { in?: V[]; isNull?: boolean } };

export const makeFilter = <V extends z.ZodType>(value: V): z.ZodType<Filter<z.infer<V>>> => {
  const self: z.ZodType<Filter<z.infer<V>>> = z.lazy(() =>
    z.union([
      z.strictObject({ and: z.array(self).min(1).max(20) }),
      z.strictObject({ or: z.array(self).min(1).max(20) }),
      z.strictObject({ not: self }),
      z.record(Identifier, ops(value)),
    ]),
  ) as z.ZodType<Filter<z.infer<V>>>;
  return self;
};

/** Filter with literal values (APIs, code, tools). */
export const RowFilter = makeFilter(Json);
/** Filter whose values are expressions (card definitions). */
export const RowFilterTemplate = makeFilter(Expression);

export const Sort = z.object({ column: Identifier, direction: z.enum(["asc", "desc"]).default("asc") });

export const TableOperation = z.enum(["find", "get", "insert", "update", "upsert", "delete"]);
export type TableOperation = z.infer<typeof TableOperation>;

export const FindRowsRequest = z.object({
  where: RowFilter.optional(),
  /** Full-text query over searchable columns; combined with `where` by AND. */
  search: z.string().max(500).optional(),
  sort: z.array(Sort).max(3).default([]),
  limit: z.number().int().min(1).max(500).default(50),
  cursor: z.string().optional(),
});
export type FindRowsRequest = z.infer<typeof FindRowsRequest>;

export const TABLE_LIMITS = { columns: 50, rowBytes: 16_384, insertBatch: 500, findLimit: 500 } as const;
