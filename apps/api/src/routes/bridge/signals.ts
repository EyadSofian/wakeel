import type { Redis } from "ioredis";

/**
 * Redis pub/sub on one subscriber connection, shared by every request that waits: `wait` listens
 * for `turn-done:<conversationId>:<seq>`, SSE for `conversation-events:<conversationId>` (§9.3).
 */
export class Signals {
  readonly #sub: Redis;
  readonly #handlers = new Map<string, Set<() => void>>();

  constructor(subscriber: Redis) {
    this.#sub = subscriber;
    this.#sub.on("message", (channel: string) => {
      for (const handler of this.#handlers.get(channel) ?? []) handler();
    });
  }

  /** Calls `handler` for each message on `channel` until the returned function is called. */
  async listen(channel: string, handler: () => void): Promise<() => Promise<void>> {
    let set = this.#handlers.get(channel);
    if (!set) {
      set = new Set();
      this.#handlers.set(channel, set);
      await this.#sub.subscribe(channel);
    }
    set.add(handler);
    return async () => {
      const current = this.#handlers.get(channel);
      current?.delete(handler);
      if (current && current.size === 0) {
        this.#handlers.delete(channel);
        await this.#sub.unsubscribe(channel).catch(() => undefined);
      }
    };
  }
}
