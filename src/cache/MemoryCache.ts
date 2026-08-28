import type { Cache, CacheStats } from "./Cache.js";

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export interface MemoryCacheOptions {
  defaultTtlSeconds: number;
  maxEntries: number;
  /** Injectable clock so tests can advance time without waiting. */
  now?: () => number;
}

/**
 * In-process TTL cache with LRU eviction.
 *
 * Insertion order of a Map is its recency order once we delete-and-reinsert on
 * every read, which gives LRU eviction without a second data structure.
 */
export class MemoryCache implements Cache {
  private readonly store = new Map<string, Entry<unknown>>();
  private readonly defaultTtlSeconds: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: MemoryCacheOptions) {
    this.defaultTtlSeconds = options.defaultTtlSeconds;
    this.maxEntries = options.maxEntries;
    this.now = options.now ?? (() => Date.now());
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      this.misses += 1;
      return undefined;
    }
    // Refresh recency.
    this.store.delete(key);
    this.store.set(key, entry);
    this.hits += 1;
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds ?? this.defaultTtlSeconds;
    if (ttl <= 0) return; // caching disabled
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: this.now() + ttl * 1000 });
    this.evictIfNeeded();
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  stats(): CacheStats {
    return {
      entries: this.store.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }

  /** Drops every expired entry. Safe to call from a periodic timer. */
  prune(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) {
        this.store.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  private evictIfNeeded(): void {
    if (this.store.size <= this.maxEntries) return;
    this.prune();
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
      this.evictions += 1;
    }
  }
}
