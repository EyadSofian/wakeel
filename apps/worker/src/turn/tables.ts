import { AppError, TableRuntimeCall } from "@wakeel/contracts";
import { type Database, runTableOperation, type TableRunContext } from "@wakeel/db";
import type { TablePort } from "@wakeel/engine";
import { lexicalTokens } from "@wakeel/retrieval";
import { ZodError } from "zod";

export interface TableOperationTrace {
  tableId: string;
  operation: TableRuntimeCall["operation"];
  rowCount: number;
}

type Context = Omit<TableRunContext, "step" | "ordinal"> & { workspaceId: string };

/** All three runtime surfaces use the same scope, receipt sequence and search normalization. */
export function turnTables(db: Database, context: Context, record: (trace: TableOperationTrace) => void): TablePort {
  const ordinals = new Map<number, number>();
  return {
    async execute(request) {
      const call = TableRuntimeCall.parse(request);
      const [owner, position] = call.idempotencyKey.split(":");
      const step = Number(position);
      if (owner !== context.turnId || !Number.isSafeInteger(step) || step < 1) {
        throw new AppError("validation_failed", {}, { detail: "The table call must belong to the current step." });
      }
      const ordinal = (ordinals.get(step) ?? 0) + 1;
      ordinals.set(step, ordinal);
      try {
        const result = await db.withWorkspace(context.workspaceId, (tx) =>
          runTableOperation(tx, { ...context, step, ordinal }, call, (text) => lexicalTokens(text).join(" ")),
        );
        record({ tableId: result.tableId, operation: call.operation, rowCount: result.rowCount });
        return result.value;
      } catch (error) {
        if (error instanceof ZodError)
          throw new AppError("validation_failed", {}, { detail: "Check the table operation arguments." });
        throw error;
      }
    },
  };
}
