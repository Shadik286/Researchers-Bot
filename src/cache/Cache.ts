/**
 * Cache abstraction.
 *
 * The orchestrator and the source adapters depend on this interface only, so a
 * Redis (or any other) implementation can be dropped in later without touching
 * the search engine: implement `Cache` and pass it into the composition root.
 */
export interface Cache {
  get<T>(key: string): Promise<T | undefined>;

  /** @param ttlSeconds - overrides the cache default when provided. */
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;

  delete(key: string): Promise<void>;

  clear(): Promise<void>;

  /** Diagnostics for `GET /api/sources/status`. */
  stats(): CacheStats;
}

export interface CacheStats {
  entries: number;
  hits: number;
  misses: number;
  evictions: number;
}

/**
 * Read-through helper. `loader` runs only on a miss, and a rejected loader is
 * never cached (a transient upstream failure must not be memoized).
 */
export async function cached<T>(
  cache: Cache,
  key: string,
  ttlSeconds: number | undefined,
  loader: () => Promise<T>,
): Promise<T> {
  const hit = await cache.get<T>(key);
  if (hit !== undefined) return hit;
  const value = await loader();
  if (value !== undefined) await cache.set(key, value, ttlSeconds);
  return value;
}

/** Builds a deterministic, collision-resistant cache key. */
export function cacheKey(namespace: string, ...parts: (string | number | undefined)[]): string {
  const tail = parts
    .filter((p) => p !== undefined && p !== "")
    .map((p) => String(p).toLowerCase().replace(/\s+/g, " ").trim())
    .join("|");
  return `${namespace}:${tail}`;
}

/** A cache that stores nothing - useful in tests and for disabling caching. */
export class NullCache implements Cache {
  private readonly counters = { entries: 0, hits: 0, misses: 0, evictions: 0 };

  async get<T>(): Promise<T | undefined> {
    this.counters.misses += 1;
    return undefined;
  }

  async set<T>(): Promise<void> {
    /* no-op */
  }

  async delete(): Promise<void> {
    /* no-op */
  }

  async clear(): Promise<void> {
    /* no-op */
  }

  stats(): CacheStats {
    return { ...this.counters };
  }
}
