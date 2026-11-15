import { type Database, insertUsageEvent, type NewUsageEvent, sql, workspaces } from "@wakeel/db";

/** Emit one measured resource use while keeping emulator and eval modes available for reporting. */
export async function emitUsage(db: Database, workspaceId: string, event: NewUsageEvent) {
  return db.withWorkspace(workspaceId, (tx) => insertUsageEvent(tx, event));
}

/** Storage samples are current occupancy, retained separately from additive consumption. */
export async function sampleStorageUsage(db: Database, now: Date) {
  const tenants = await db.platform.select({ id: workspaces.id }).from(workspaces);
  const period = now.toISOString().slice(0, 13);
  for (const workspace of tenants) {
    await db.withWorkspace(workspace.id, async (tx) => {
      const rows = await tx.execute(sql`select b.id as bot_id,
        case when b.archived_at is not null then 0 else
          (select count(*)::int from table_rows r join bot_tables t on t.id=r.table_id where t.bot_id=b.id) end as rows,
        case when b.archived_at is not null then 0 else
          (select coalesce(sum(pg_column_size(c)),0)::float8 from kb_chunks c join knowledge_bases k on k.id=c.kb_id
            where k.bot_id=b.id) end as bytes from bots b`);
      for (const row of rows.rows) {
        const botId = String(row["bot_id"]);
        for (const [kind, unit, quantity] of [
          ["table_rows", "rows", Number(row["rows"])],
          ["kb_storage_bytes", "bytes", Number(row["bytes"])],
        ] as const) {
          await insertUsageEvent(tx, {
            kind,
            unit,
            quantity,
            mode: "live",
            botId,
            sourceKey: `storage:${botId}:${kind}:${period}`,
            detail: { measurement: "snapshot", sampledAt: now.toISOString() },
          });
        }
      }
    });
  }
}
