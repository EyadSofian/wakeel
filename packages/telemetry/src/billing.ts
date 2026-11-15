import type { DailyUsage } from "@wakeel/contracts";

/** Receives committed daily live totals. Implementations must replace by workspace/day, not add. */
export interface BillingAdapter {
  writeDaily(input: { workspaceId: string; day: string; usage: readonly DailyUsage[] }): Promise<void>;
}

/** Manual invoicing is the default: the worker stores roll-ups without charging or sending data. */
export const noOpBillingAdapter: BillingAdapter = { writeDaily: async () => {} };
