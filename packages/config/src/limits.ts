/**
 * Platform limits. Engine limits live in `@wakeel/contracts` because `packages/engine` may import
 * only contracts (architecture §1.3); they are re-exported here so every other package reads limits
 * from one place. Bots may lower `turnSeconds` and `stepsPerTurn`, never raise them.
 *
 * Browser-safe: no Node imports, so the Studio can show limits in forms and help text.
 */
export {
  INLINE_PAYLOAD_BYTES,
  LIMITS,
  RETRY_SCHEDULE_SECONDS,
  SIGNATURE_TOLERANCE_SECONDS,
  STATE_MAX_BYTES,
  TABLE_LIMITS,
} from "@wakeel/contracts";

import { RETRY_SCHEDULE_SECONDS } from "@wakeel/contracts";

/** Studio and Bridge API (architecture §9.1, ADR-012). */
export const API_LIMITS = {
  /** `?wait=` on inbound calls; above this the caller gets 202 and polls. */
  waitSecondsMax: 55,
  pageSizeDefault: 50,
  pageSizeMax: 200,
  /** `SendMessageRequest.metadata`, serialised. */
  metadataBytes: 8 * 1024,
  /** Failed sign-ins per email per minute before `rate_limited` (build plan 1.2). */
  signInFailuresPerMinute: 5,
} as const;

/** Outbound webhook delivery (architecture §9.2). */
export const WEBHOOK_LIMITS = {
  /** A 2xx must arrive within this time. */
  timeoutMs: 10_000,
  retrySeconds: RETRY_SCHEDULE_SECONDS,
  retryJitter: 0.2,
  /** Consecutive dead events before the connection is disabled. */
  disableAfterDead: 20,
} as const;

/** Defaults for a workspace plan until plans are configurable (architecture §10, §12). */
export const PLAN_DEFAULTS = {
  tablesPerBot: 50,
  columnsPerTable: 50,
  rowsPerTable: 100_000,
  rowBytes: 16_384,
  spanRetentionDays: 30,
  conversationRetentionDays: 90,
} as const;

/** Background work (architecture §4, §15). */
export const WORKER_LIMITS = {
  janitorIntervalSeconds: 30,
  /** I/O-bound turns one worker process handles at once; size workers by this. */
  concurrentTurnsPerProcess: 50,
} as const;
