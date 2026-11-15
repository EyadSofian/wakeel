import { AppError, type Column, Identifier, Json } from "@wakeel/contracts";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { canonicalValue } from "./validation";

const comparison = z
  .strictObject({
    eq: Json,
    ne: Json,
    gt: Json,
    gte: Json,
    lt: Json,
    lte: Json,
    in: z.array(Json).max(200),
    contains: Json,
    startsWith: Json,
    isNull: z.boolean(),
  })
  .partial();
const ordering = { gt: sql`>`, gte: sql`>=`, lt: sql`<`, lte: sql`<=` } as const;
const invalid = () =>
  new AppError("validation_failed", {}, { detail: "Use a known column and an operator for its type." });

function predicate(column: Column, raw: unknown): SQL {
  const condition = comparison.safeParse(raw);
  if (!condition.success || Object.keys(condition.data).length !== 1) throw invalid();
  const value = condition.data;
  const json = sql`(table_rows.data -> ${column.id}::text)`;
  if (value.isNull !== undefined) {
    const isNull = sql`(${json} is null or ${json} = 'null'::jsonb)`;
    return value.isNull ? isNull : sql`not ${isNull}`;
  }
  const text = sql`(table_rows.data ->> ${column.id}::text)`;
  const canonical = (candidate: Json) => {
    if (candidate === null) throw invalid();
    return canonicalValue(column, candidate);
  };
  if (value.in !== undefined) {
    const candidates = value.in.map(canonical);
    return sql`exists (select 1 from jsonb_array_elements(${JSON.stringify(candidates)}::jsonb) as candidate(value)
      where candidate.value = ${json})`;
  }
  if (value.eq !== undefined) return sql`coalesce(${json} = ${JSON.stringify(canonical(value.eq))}::jsonb, false)`;
  if (value.ne !== undefined)
    return sql`coalesce(nullif(${json}, 'null'::jsonb) <> ${JSON.stringify(canonical(value.ne))}::jsonb, false)`;

  if (value.contains !== undefined || value.startsWith !== undefined) {
    const match = value.contains ?? value.startsWith;
    if (!["string", "enum"].includes(column.type) || typeof match !== "string") throw invalid();
    const position = sql`strpos(${text}, ${match})`;
    return value.contains !== undefined ? sql`coalesce(${position} > 0, false)` : sql`coalesce(${position} = 1, false)`;
  }

  if (column.type === "json" || column.type === "boolean") throw invalid();
  for (const op of ["gt", "gte", "lt", "lte"] as const) {
    const right = value[op];
    if (right === undefined) continue;
    const param = canonical(right);
    if (column.type === "number")
      return sql`coalesce(${text}::numeric ${ordering[op]} ${String(param)}::numeric, false)`;
    if (column.type === "date") return sql`coalesce(${text}::timestamptz ${ordering[op]} ${param}::timestamptz, false)`;
    return sql`coalesce(${text} ${ordering[op]} ${param}, false)`;
  }
  throw invalid();
}

/** Compile a bounded filter for the table_rows relation. Only fixed SQL syntax enters the query text. */
export function compileRowFilter(columns: Column[], input: unknown): SQL {
  const names = new Map(columns.map((column) => [column.name, column]));
  let nodes = 0;
  function visit(node: unknown, depth: number): SQL {
    if (depth > 24 || ++nodes > 500 || !node || typeof node !== "object" || Array.isArray(node)) throw invalid();
    const entries = Object.entries(node);
    if (!entries.length || entries.length > columns.length) throw invalid();
    const [name, operand] = entries[0] ?? [];
    if (entries.length === 1) {
      if ((name === "and" || name === "or") && Array.isArray(operand)) {
        if (operand.length === 0 || operand.length > 20) throw invalid();
        const join = name === "and" ? sql` and ` : sql` or `;
        return sql`(${sql.join(
          operand.map((child: unknown) => visit(child, depth + 1)),
          join,
        )})`;
      }
      if (name === "not" && (!names.has(name) || !comparison.safeParse(operand).success)) {
        return sql`(not ${visit(operand, depth + 1)})`;
      }
    }
    const terms = entries.map(([key, condition]) => {
      if (!Identifier.safeParse(key).success) throw invalid();
      const column = names.get(key);
      if (!column) throw invalid();
      return predicate(column, condition);
    });
    return sql`(${sql.join(terms, sql` and `)})`;
  }
  return visit(input, 0);
}
