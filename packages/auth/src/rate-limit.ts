import { createHash } from "node:crypto";
import { AppError } from "@wakeel/contracts";
import type { Redis } from "ioredis";

/**
 * Counts failed sign-ins per email in a fixed one-minute window (build plan 1.2, threat T7). After
 * `max` failures the next attempt is `rate_limited` until the window ends, whatever the password.
 * Counters live in Redis so every api replica shares them; the email is hashed so Redis never holds
 * addresses.
 */
export interface SignInLimiter {
  /** Throws `rate_limited` with the seconds left when the email has used up its failures. */
  check(email: string): Promise<void>;
  recordFailure(email: string): Promise<void>;
  /** A successful sign-in clears the count. */
  reset(email: string): Promise<void>;
}

export interface SignInLimiterOptions {
  maxFailures: number;
  windowSeconds?: number;
}

export function createSignInLimiter(redis: Redis, options: SignInLimiterOptions): SignInLimiter {
  const windowSeconds = options.windowSeconds ?? 60;
  const keyFor = (email: string) =>
    `auth:sign-in-failures:${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}`;

  return {
    async check(email) {
      const key = keyFor(email);
      const [count, ttl] = await Promise.all([redis.get(key), redis.ttl(key)]);
      if (Number(count ?? 0) >= options.maxFailures) {
        throw new AppError("rate_limited", { retryAfter: ttl > 0 ? ttl : windowSeconds });
      }
    },
    async recordFailure(email) {
      const key = keyFor(email);
      // The window starts at the first failure; later failures do not extend it.
      await redis.multi().incr(key).expire(key, windowSeconds, "NX").exec();
    },
    async reset(email) {
      await redis.del(keyFor(email));
    },
  };
}
