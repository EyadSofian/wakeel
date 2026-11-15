import { DailyUsage } from "@wakeel/contracts";
import { sql } from "drizzle-orm";
import type { Tx } from "../client";
import { currentWorkspace } from "./scope";

const validDay = DailyUsage.shape.day;

/** Rebuild one UTC day atomically; consumption sums and storage takes the last sample (ADR-051). */
export async function rollupUsageDay(tx: Tx, day: string): Promise<DailyUsage[]> {
  validDay.parse(day);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${currentWorkspace} || ':usage:' || ${day}, 0))`);
  await tx.execute(sql`delete from usage_daily where day=${day}::date`);
  await tx.execute(sql`with events as (
      select * from usage_events where at >= ${day}::date::timestamp at time zone 'UTC'
        and at < (${day}::date + 1)::timestamp at time zone 'UTC'
    ), occupancy as (
      select distinct on (bot_id, kind, model, mode) * from events
      where kind in ('kb_storage_bytes','table_rows')
      order by bot_id, kind, model, mode, at desc, id desc
    ), measured as (
      select bot_id, kind, model, mode, quantity, cost_micro_usd from events
        where kind not in ('kb_storage_bytes','table_rows')
      union all select bot_id, kind, model, mode, quantity, cost_micro_usd from occupancy
    ) insert into usage_daily (workspace_id, day, bot_id, kind, model, mode, quantity, cost_micro_usd)
      select ${currentWorkspace}, ${day}::date, bot_id, kind, model, mode, sum(quantity), sum(cost_micro_usd)
      from measured group by bot_id, kind, model, mode`);
  return readDailyUsage(tx, day);
}

/** Reads a day's roll-up under the caller's workspace; quantities and costs are validated on read. */
export async function readDailyUsage(tx: Tx, day: string): Promise<DailyUsage[]> {
  validDay.parse(day);
  const rows = await tx.execute(sql`select to_char(day, 'YYYY-MM-DD') as day, bot_id as "botId", kind, model, mode,
    quantity::float8 as quantity, cost_micro_usd::text as cost from usage_daily
    where day=${day}::date order by bot_id nulls first, kind, model nulls first, mode`);
  return rows.rows.map((row) => DailyUsage.parse({ ...row, costMicroUsd: Number(row["cost"]) }));
}

/** Backfill missing completed days in bounded batches, and refresh yesterday for late commits. */
export async function usageDaysToRollup(tx: Tx, today: string): Promise<string[]> {
  validDay.parse(today);
  const rows = await tx.execute(sql`with source_days as (
      select distinct (at at time zone 'UTC')::date as day from usage_events
      where at < ${today}::date::timestamp at time zone 'UTC'
    ) select to_char(s.day, 'YYYY-MM-DD') as day from source_days s
    where s.day=${today}::date - 1 or not exists (select 1 from usage_daily d where d.day=s.day)
    order by s.day limit 31`);
  return rows.rows.map((row) => validDay.parse(row["day"]));
}
