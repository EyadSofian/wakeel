import { NewUsage, newId, UsageKind, UsageMode } from "@wakeel/contracts";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "../client";
import { currentWorkspace } from "./scope";

export type NewUsageEvent = z.input<typeof NewUsage>;

export async function insertUsageEvent(tx: Tx, input: NewUsageEvent): Promise<string> {
  const e = NewUsage.parse(input);
  const id = newId("usg");
  if (e.sourceKey) {
    const inserted = await tx.execute(sql`insert into usage_sources (workspace_id, source_key, usage_id)
      values (${currentWorkspace}, ${e.sourceKey}, ${id}) on conflict do nothing returning usage_id`);
    if (!inserted.rows.length) {
      const prior = await tx.execute(sql`select usage_id from usage_sources where source_key = ${e.sourceKey}`);
      return z.string().parse(prior.rows[0]?.["usage_id"]);
    }
  }
  await tx.execute(sql`insert into usage_events
      (id, workspace_id, bot_id, kind, quantity, unit, model, cost_micro_usd, mode, conversation_id, turn_id, detail)
    values (${id}, ${currentWorkspace}, ${e.botId ?? null}, ${e.kind}, ${e.quantity}, ${e.unit}, ${e.model ?? null},
      ${e.costMicroUsd}, ${e.mode}, ${e.conversationId ?? null}, ${e.turnId ?? null}, ${JSON.stringify(e.detail)}::jsonb)`);
  return id;
}

/** Called after inserting an inbound user message, in the same conversation transaction. */
export async function countConversationUsage(tx: Tx, conversationId: string) {
  const record = (
    await tx.execute(sql`select c.bot_id, c.mode,
    to_char(now() at time zone 'UTC', 'YYYY-MM') as period,
    (select count(*)::int from messages m where m.conversation_id = c.id and m.direction = 'in'
      and m.created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC') as user_messages
    from conversations c where c.id=${conversationId} for update`)
  ).rows[0];
  if (!record || Number(record["user_messages"]) < 2) return;
  await insertUsageEvent(tx, {
    kind: "conversation",
    quantity: 1,
    unit: "conversations",
    botId: z.string().parse(record["bot_id"]),
    conversationId,
    mode: UsageMode.parse(record["mode"]),
    sourceKey: `conversation:${conversationId}:${record["period"]}`,
  });
}

/** Live usage is the only source of billable aggregates. */
export async function usageTotals(tx: Tx, from: Date, until: Date) {
  const result = await tx.execute(sql`with events as (select * from usage_events where mode='live'
      and at >= ${from.toISOString()}::timestamptz and at < ${until.toISOString()}::timestamptz
    ), occupancy as (
      select distinct on (e.bot_id, e.kind) e.kind, e.quantity, e.cost_micro_usd from events e
      join bots b on b.id=e.bot_id and b.archived_at is null
      where e.kind in ('table_rows', 'kb_storage_bytes')
      order by e.bot_id, e.kind, e.at desc, e.id desc
    ), measured as (
      select kind, quantity, cost_micro_usd from events where kind not in ('table_rows', 'kb_storage_bytes')
      union all select * from occupancy
    ) select kind, sum(quantity)::float8 as quantity, sum(cost_micro_usd)::text as cost from measured
    group by kind order by kind`);
  return result.rows.map((row) => ({
    kind: UsageKind.parse(row["kind"]),
    quantity: z.number().parse(row["quantity"]),
    costMicroUsd: Number(z.string().parse(row["cost"])),
  }));
}
