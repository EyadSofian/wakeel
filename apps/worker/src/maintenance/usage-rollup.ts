import { type Database, rollupUsageDay, usageDaysToRollup, workspaces } from "@wakeel/db";
import { type BillingAdapter, noOpBillingAdapter } from "@wakeel/telemetry";

/** Persist completed UTC days and offer only live totals to the configured billing adapter. */
export async function rollupUsage(db: Database, now: Date, billing: BillingAdapter = noOpBillingAdapter) {
  const today = now.toISOString().slice(0, 10);
  const tenants = await db.platform.select({ id: workspaces.id }).from(workspaces);
  for (const workspace of tenants) {
    const days = await db.withWorkspace(workspace.id, (tx) => usageDaysToRollup(tx, today));
    for (const day of days) {
      const usage = await db.withWorkspace(workspace.id, (tx) => rollupUsageDay(tx, day));
      await billing.writeDaily({ workspaceId: workspace.id, day, usage: usage.filter((row) => row.mode === "live") });
    }
  }
}
