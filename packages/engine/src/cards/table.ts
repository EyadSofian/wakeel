import { AppError, type Json } from "@wakeel/contracts";
import { indexDefinition } from "../definition";
import { writeFor } from "../variables";
import { CardEvaluator, type Evaluated } from "./render";
import type { ExecutorOf } from "./types";

type Read = (values: Evaluated) => Json;
const operators = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "contains", "startsWith", "in", "isNull"]);

function readExpression(source: unknown, evaluator: CardEvaluator): Read {
  if (typeof source !== "string") throw new AppError("validation_failed");
  const slot = evaluator.expression(source);
  return (resolved) => {
    const value = resolved.value(slot);
    if (value === undefined)
      throw new AppError("expression_error", { message: "The table expression returned undefined" });
    return value;
  };
}

function filterPlan(input: unknown, evaluator: CardEvaluator, depth = 0): Read {
  if (depth > 24 || !input || typeof input !== "object" || Array.isArray(input))
    throw new AppError("validation_failed");
  const parts = Object.entries(input).map(([column, value]): [string, Read] => {
    if ((column === "and" || column === "or") && Array.isArray(value)) {
      const children = value.map((item: unknown) => filterPlan(item, evaluator, depth + 1));
      return [column, (resolved) => children.map((read) => read(resolved))];
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("validation_failed");
    const entries = Object.entries(value);
    const [op, arg] = entries[0] ?? [];
    const condition =
      entries.length === 1 &&
      op !== undefined &&
      operators.has(op) &&
      (op === "in" ? Array.isArray(arg) : op === "isNull" ? typeof arg === "boolean" : typeof arg === "string");
    if (column === "not" && !condition) {
      return [column, filterPlan(value, evaluator, depth + 1)];
    }
    const predicates = entries.map(([operator, argument]): [string, Read] => {
      if (operator === "isNull" && typeof argument === "boolean") return [operator, () => argument];
      if (operator === "in" && Array.isArray(argument)) {
        const slots = argument.map((expr: unknown) => readExpression(expr, evaluator));
        return [operator, (resolved) => slots.map((read) => read(resolved))];
      }
      return [operator, readExpression(argument, evaluator)];
    });
    return [column, (resolved) => Object.fromEntries(predicates.map(([operator, read]) => [operator, read(resolved)]))];
  });
  return (resolved) => Object.fromEntries(parts.map(([name, read]) => [name, read(resolved)]));
}

/** Evaluates table card expressions within the ordinary expression port and delegates data access. */
export const table: ExecutorOf<"table"> = async (ctx) => {
  if (!ctx.tables)
    throw new AppError("internal_error", {}, { detail: "Table operations are not wired for this turn." });
  const { card } = ctx;
  const evaluator = new CardEvaluator();
  const values = Object.entries(card.values ?? {}).map(
    ([name, expression]) => [name, readExpression(expression, evaluator)] as const,
  );
  const where = card.where ? filterPlan(card.where, evaluator) : undefined;
  const search = card.search === undefined ? undefined : evaluator.template(card.search);
  const resolved = await evaluator.run(ctx.scopes, ctx.sandbox);
  const input: Record<string, Json> = {};
  if (where) input["where"] = where(resolved);
  if (card.values) input["values"] = Object.fromEntries(values.map(([name, read]) => [name, read(resolved)]));
  if (search !== undefined) input["search"] = resolved.text(search);
  if (card.upsertOn !== undefined) input["on"] = card.upsertOn;
  if (card.operation === "find" || card.operation === "get") {
    input["sort"] = card.sort;
    input["limit"] = card.limit;
  }

  const result = await ctx.tables.execute({
    target: { id: card.tableId },
    operation: card.operation,
    surface: "card",
    input,
    idempotencyKey: ctx.idempotencyKey,
  });
  const noMatch =
    (card.operation === "get" && result === null) ||
    (card.operation === "find" && Array.isArray(result) && result.length === 0);
  const writes =
    card.into && card.operation !== "delete" && result !== null
      ? [writeFor(indexDefinition(ctx.definition), card.into, result)]
      : [];
  return { outcome: noMatch ? { type: "goto", port: "not_found" } : { type: "next" }, writes };
};
