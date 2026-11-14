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

import { LIMITS, RETRY_SCHEDULE_SECONDS } from "@wakeel/contracts";

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

/**
 * Egress proxy (architecture §5.2, §5.3; ADR-020). The response, time and redirect values are the
 * guest `fetch` limits; callers may ask for less, never more.
 */
export const EGRESS_LIMITS = {
  timeoutMs: LIMITS.fetchTimeoutMs,
  responseBytes: LIMITS.fetchResponseBytes,
  redirects: LIMITS.fetchRedirects,
  /** Decoded request body a caller may send out. */
  requestBodyBytes: LIMITS.fetchResponseBytes,
  /** Header bytes in either direction; Node's own default. */
  headerBytes: 16 * 1024,
} as const;

/** Uploaded files (ADR-039). */
export const FILE_LIMITS = {
  /** Knowledge base source files: the types the parser reads (8.2). */
  kbSource: {
    maxBytes: 50 * 1024 * 1024,
    mimes: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/html",
      "text/markdown",
      "text/plain",
      "text/csv",
      "image/png",
      "image/jpeg",
    ],
  },
  uploadUrlSeconds: 15 * 60,
  downloadUrlSeconds: 5 * 60,
} as const;

/** Knowledge base ingestion (tasks 8.2, 8.4; ADR-040). */
export const KB_LIMITS = {
  /** Pages per document sent to the vision model; the Studio shows the estimate before ingestion. */
  maxOcrPagesPerDocument: 50,
  /** The parser's own limits are its env (PARSER_MAX_*); this is the worker's wait for an answer. */
  parserTimeoutMs: 200_000,
} as const;
