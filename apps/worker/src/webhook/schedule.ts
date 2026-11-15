import { RETRY_SCHEDULE_SECONDS } from "@wakeel/contracts";

/** ±20% (architecture §9.2), so receivers recovering from an outage are not hit in lockstep. */
const JITTER = 0.2;

/**
 * When attempt `failedAttempt + 1` is due after attempt `failedAttempt` failed at `attemptedAt`, or
 * `undefined` when the schedule is used up and the event is dead. `random` returns [0, 1); 0.5 gives
 * the schedule's exact delay.
 */
export function retryAt(failedAttempt: number, attemptedAt: Date, random: () => number): Date | undefined {
  const seconds = RETRY_SCHEDULE_SECONDS[failedAttempt - 1];
  if (seconds === undefined) return undefined;
  const factor = 1 + (random() * 2 - 1) * JITTER;
  return new Date(attemptedAt.getTime() + Math.round(seconds * 1000 * factor));
}
