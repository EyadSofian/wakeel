import type { Clock } from "./clock";

export interface RateSettings {
  /** Tokens added per minute. */
  perMinute: number;
  /** Bucket size: requests allowed at once. */
  burst: number;
}

export type Take = { ok: true } | { ok: false; retryAfterSeconds: number };

interface Bucket {
  tokens: number;
  at: number;
}

/** Above this many tracked workspaces, full buckets are dropped (a full bucket equals no bucket). */
const SWEEP_AT = 10_000;

/**
 * Per-workspace token bucket, held in this replica's memory (ADR-020). Each outbound request takes
 * one token, redirects and blocked requests included, so probing the policy costs the same as using
 * it.
 */
export class RateLimiter {
  readonly #clock: Clock;
  readonly #perMs: number;
  readonly #burst: number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(clock: Clock, settings: RateSettings) {
    this.#clock = clock;
    this.#perMs = settings.perMinute / 60_000;
    this.#burst = settings.burst;
  }

  take(workspaceId: string): Take {
    const now = this.#clock.now();
    const bucket = this.#refill(this.#buckets.get(workspaceId), now);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.#buckets.set(workspaceId, bucket);
      if (this.#buckets.size > SWEEP_AT) this.#sweep(now);
      return { ok: true };
    }
    this.#buckets.set(workspaceId, bucket);
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / this.#perMs / 1000)) };
  }

  #refill(bucket: Bucket | undefined, now: number): Bucket {
    if (!bucket) return { tokens: this.#burst, at: now };
    return { tokens: Math.min(this.#burst, bucket.tokens + (now - bucket.at) * this.#perMs), at: now };
  }

  #sweep(now: number): void {
    for (const [id, bucket] of this.#buckets) {
      if (this.#refill(bucket, now).tokens >= this.#burst) this.#buckets.delete(id);
    }
  }
}
