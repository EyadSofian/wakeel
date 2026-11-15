import {
  acknowledgeTracePayloadDeletes,
  type Database,
  expireTraceSpans,
  type ObjectStore,
  pendingTracePayloadDeletes,
  sql,
  workspaces,
} from "@wakeel/db";

export async function maintainTraces(
  db: Database,
  store: Pick<ObjectStore, "delete">,
  now: Date,
  retention: Readonly<Record<string, number>>,
  reportFailure: () => void,
) {
  await db.platform.execute(sql`select trace_maintenance.prepare_trace_partitions()`);
  const tenants = await db.platform.select({ id: workspaces.id, plan: workspaces.plan }).from(workspaces);
  for (const tenant of tenants) {
    const days = Object.hasOwn(retention, tenant.plan) ? (retention[tenant.plan] ?? 30) : 30;
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    const pending = await db.withWorkspace(tenant.id, async (tx) => {
      await expireTraceSpans(tx, cutoff);
      return pendingTracePayloadDeletes(tx);
    });
    const deleted: string[] = [];
    for (const key of pending) {
      try {
        if (!key.startsWith(`traces/${tenant.id}/`)) {
          reportFailure();
          continue;
        }
        await store.delete(key, { signal: AbortSignal.timeout(2000) });
        deleted.push(key);
      } catch {
        reportFailure();
      }
    }
    await db.withWorkspace(tenant.id, (tx) => acknowledgeTracePayloadDeletes(tx, deleted));
  }
  await db.platform.execute(sql`select trace_maintenance.drop_empty_trace_partition()`);
}
