import { Redis } from "ioredis";

/**
 * The adapter's only state (spec §6): event ids already handled, and numbered-list mappings for
 * channels without `input_select`. Both expire after 24 hours.
 */
export interface Store {
  /** True the first time `key` is claimed within the TTL; false for a repeat. */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
  /** Forgets a claim, so a failed delivery is processed again when the platform retries it. */
  release(key: string): Promise<void>;
  setJson(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  getJson<T>(key: string): Promise<T | undefined>;
}

export const DAY_SECONDS = 24 * 60 * 60;

/** In-process store for tests and single-instance development. Uses an injected clock. */
export function memoryStore(now: () => number = Date.now): Store {
  const entries = new Map<string, { value: string; expiresAt: number }>();
  const live = (key: string) => {
    const e = entries.get(key);
    if (e && e.expiresAt <= now()) entries.delete(key);
    return entries.get(key);
  };
  return {
    async claim(key, ttl) {
      if (live(key)) return false;
      entries.set(key, { value: "1", expiresAt: now() + ttl * 1000 });
      return true;
    },
    async release(key) {
      entries.delete(key);
    },
    async setJson(key, value, ttl) {
      entries.set(key, { value: JSON.stringify(value), expiresAt: now() + ttl * 1000 });
    },
    async getJson<T>(key: string) {
      const e = live(key);
      return e ? (JSON.parse(e.value) as T) : undefined;
    },
  };
}

/** Redis store for deployments with more than one instance or restarts that must not repeat work. */
export function redisStore(url: string): Store & { close(): Promise<void> } {
  const redis = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
  const k = (key: string) => `adapter-chatwoot:${key}`;
  return {
    async claim(key, ttl) {
      return (await redis.set(k(key), "1", "EX", ttl, "NX")) === "OK";
    },
    async release(key) {
      await redis.del(k(key));
    },
    async setJson(key, value, ttl) {
      await redis.set(k(key), JSON.stringify(value), "EX", ttl);
    },
    async getJson<T>(key: string) {
      const raw = await redis.get(k(key));
      return raw === null ? undefined : (JSON.parse(raw) as T);
    },
    async close() {
      await redis.quit();
    },
  };
}
