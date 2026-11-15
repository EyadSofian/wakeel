/**
 * A clock tests control. CLAUDE.md §7: tests never sleep on real time. Code under test takes a
 * clock (the engine declares it as a port); tests pass a FakeClock and move time with `advance`.
 *
 * Timers fire in time order. After each one, `advance` lets pending promise continuations run, so
 * code that sleeps, wakes and sleeps again behaves as it would with a real clock.
 */
interface Timer {
  at: number;
  seq: number;
  fire: () => void;
}

export class FakeClock {
  #now: number;
  #timers: Timer[] = [];
  #seq = 0;

  constructor(start: number | string | Date = "2026-11-13T09:00:00.000Z") {
    this.#now = typeof start === "number" ? start : new Date(start).getTime();
    if (!Number.isFinite(this.#now)) throw new RangeError(`FakeClock: invalid start time ${String(start)}`);
  }

  /** Milliseconds since the epoch. */
  now(): number {
    return this.#now;
  }

  date(): Date {
    return new Date(this.#now);
  }

  iso(): string {
    return this.date().toISOString();
  }

  /** Resolves when the clock has advanced by `ms`. Rejects with an AbortError if `signal` aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const handle = this.setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        this.clearTimeout(handle);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  setTimeout(fn: () => void, ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`FakeClock: delay must be 0 or more; got ${ms}`);
    const seq = ++this.#seq;
    this.#timers.push({ at: this.#now + ms, seq, fire: fn });
    return seq;
  }

  clearTimeout(handle: number): void {
    this.#timers = this.#timers.filter((t) => t.seq !== handle);
  }

  /** Timers not yet fired. */
  pending(): number {
    return this.#timers.length;
  }

  /** Moves time forward by `ms`, firing every timer that falls due, in order. */
  async advance(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`FakeClock: cannot advance by ${ms}`);
    const target = this.#now + ms;
    await flush();
    for (;;) {
      const next = this.#nextDue(target);
      if (!next) break;
      this.#timers = this.#timers.filter((t) => t !== next);
      this.#now = next.at;
      next.fire();
      await flush();
    }
    this.#now = target;
    await flush();
  }

  /** Advances to each pending timer until none remain. Stops after `limit` timers to catch endless loops. */
  async runAll(limit = 10_000): Promise<void> {
    for (let fired = 0; ; fired++) {
      await flush();
      const next = this.#nextDue(Number.POSITIVE_INFINITY);
      if (!next) return;
      if (fired >= limit)
        throw new Error(`FakeClock.runAll: more than ${limit} timers; is something rescheduling forever?`);
      await this.advance(next.at - this.#now);
    }
  }

  #nextDue(limit: number): Timer | undefined {
    let best: Timer | undefined;
    for (const t of this.#timers) {
      if (t.at > limit) continue;
      if (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq)) best = t;
    }
    return best;
  }
}

/** Lets every queued promise continuation run. Uses setImmediate, which does not depend on time. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

export function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
