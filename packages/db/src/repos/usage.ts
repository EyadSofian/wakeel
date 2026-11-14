import { type Json, newId } from "@wakeel/contracts";
import { sql } from "drizzle-orm";
import type { Tx } from "../client";
import { currentWorkspace } from "./scope";

/** One metered call (task 6.1, architecture §13). Emulator and eval rows keep their mode and are never billed. */
export interface NewUsageEvent {
  kind: "llm_tokens" | "embedding_tokens";
  quantity: number;
  unit: "tokens";
  model: string;
  costMicroUsd: number;
  mode: "live" | "emulator" | "eval";
  botId?: string;
  conversationId?: string;
  turnId?: string;
  detail: Record<string, Json>;
}

export async function insertUsageEvent(tx: Tx, e: NewUsageEvent): Promise<string> {
  const id = newId("usg");
  await tx.execute(sql`insert into usage_events
      (id, workspace_id, bot_id, kind, quantity, unit, model, cost_micro_usd, mode, conversation_id, turn_id, detail)
    values (${id}, ${currentWorkspace}, ${e.botId ?? null}, ${e.kind}, ${e.quantity}, ${e.unit}, ${e.model},
      ${e.costMicroUsd}, ${e.mode}, ${e.conversationId ?? null}, ${e.turnId ?? null}, ${JSON.stringify(e.detail)}::jsonb)`);
  return id;
}
