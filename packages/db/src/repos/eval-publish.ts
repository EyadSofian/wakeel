import { type BotDefinition, EvalPublishStatus } from "@wakeel/contracts";
import { sql } from "drizzle-orm";
import type { Tx } from "../client";

export async function evalPublishStatus(tx: Tx, botId: string, definition: BotDefinition) {
  const rows = await tx.execute(sql`select distinct on (suite_id) status from eval_runs
    where bot_id=${botId} and target->>'kind'='draft' and status in ('passed','failed','error')
      and definition #- '{manifest,settings,blockPublishOnFailingEvals}'
        = (${JSON.stringify(definition)}::jsonb #- '{manifest,settings,blockPublishOnFailingEvals}')
    order by suite_id, id desc`);
  return EvalPublishStatus.parse({
    passed: rows.rows.filter((row) => row["status"] === "passed").length,
    failed: rows.rows.filter((row) => row["status"] === "failed").length,
    errors: rows.rows.filter((row) => row["status"] === "error").length,
  });
}
