import { describe, expect, it } from "vitest";

import { NullCache, cacheKey, cached } from "../src/cache/Cache.js";
import { MemoryCache } from "../src/cache/MemoryCache.js";

describe("MemoryCache", () => {
  it("stores and returns a value", async () => {
    const cache = new MemoryCache({ defaultTtlSeconds: 60, maxEntries: 10 });
    await cache.set("k", { a: 1 });
    expect(await cache.get("k")).toEqual({ a: 1 });
    expect(cache.stats()).toMatchObject({ entries: 1, hits: 1, misses: 0 });
  });

  it("returns undefined for a miss", async () => {
    const cache = new MemoryCache({ defaultTtlSeconds: 60, maxEntries: 10 });
    expect(await cache.get("nope")).toBeUndefined();
    expect(cache.stats().misses).toBe(1);
  });

  it("expires entries after the TTL", async () => {
    let now = 1_000_000;
    const cache = new MemoryCache({ defaultTtlSeconds: 10, maxEntries: 10, now: () => now });

    await cache.set("k", "v");
    now += 9_000;
    expect(await cache.get("k")).toBe("v");

    now += 2_000;
    expect(await cache.get("k")).toBeUndefined();
  });

  it("honours a per-entry TTL override", async () => {
    let now = 0;
    const cache = new MemoryCache({ defaultTtlSeconds: 3600, maxEntries: 10, now: () => now });
    await cache.set("short", "v", 1);
    now += 1500;
    expect(await cache.get("short")).toBeUndefined();
  });

  it("caches nothing when the TTL is zero", async () => {
    const cache = new MemoryCache({ defaultTtlSeconds: 0, maxEntries: 10 });
    await cache.set("k", "v");
    expect(await cache.get("k")).toBeUndefined();
  });

  it("evicts the least recently used entry when full", async () => {
    const cache = new MemoryCache({ defaultTtlSeconds: 60, maxEntries: 10 });
    for (let i = 0; i < 10; i += 1) await cache.set(`k${i}`, i);

    // Touch k0 so k1 becomes the least recently used.
    await cache.get("k0");
    await cache.set("k10", 10);

    expect(await cache.get("k0")).toBe(0);
    expect(await cache.get("k1")).toBeUndefined();
    expect(cache.stats().evictions).toBe(1);
  });

  it("prunes expired entries on demand", async () => {
    let now = 0;
    const cache = new MemoryCache({ defaultTtlSeconds: 1, maxEntries: 100, now: () => now });
    await cache.set("a", 1);
    await cache.set("b", 2);
    now += 5000;
    expect(cache.prune()).toBe(2);
    expect(cache.stats().entries).toBe(0);
  });

  it("supports delete and clear", async () => {
    const cache = new MemoryCache({ defaultTtlSeconds: 60, maxEntries: 10 });
    await cache.set("a", 1);
    await cache.set("b", 2);
    await cache.delete("a");
    expect(await cache.get("a")).toBeUndefined();
    await cache.clear();
    expect(cache.stats().entries).toBe(0);
  });
});

describe("cached()", () => {
  it("runs the loader only on a miss", async () => {
    const cache = new MemoryCache({ defaultTtlSeconds: 60, maxEntries: 10 });
    let calls = 0;
    const loader = async (): Promise<string> => {
      calls += 1;
      return "value";
    };

    expect(await cached(cache, "k", 60, loader)).toBe("value");
    expect(await cached(cache, "k", 60, loader)).toBe("value");
    expect(calls).toBe(1);
  });

  it("does not memoize a failed loader", async () => {
    const cache = new MemoryCache({ defaultTtlSeconds: 60, maxEntries: 10 });
    await expect(
      cached(cache, "k", 60, async () => {
        throw new Error("upstream down");
      }),
    ).rejects.toThrow("upstream down");
    expect(await cache.get("k")).toBeUndefined();
  });
});

describe("cacheKey", () => {
  it("builds a deterministic, normalized key", () => {
    expect(cacheKey("doaj:search", "Deep  Fake", 20)).toBe("doaj:search:deep fake|20");
    expect(cacheKey("x", undefined, "", "a")).toBe("x:a");
    expect(cacheKey("n", "A")).toBe(cacheKey("n", "a"));
  });
});

describe("NullCache", () => {
  it("never stores anything, so a Redis swap is a drop-in change", async () => {
    const cache = new NullCache();
    await cache.set("k", "v");
    expect(await cache.get("k")).toBeUndefined();
    expect(cache.stats().entries).toBe(0);
  });
});
