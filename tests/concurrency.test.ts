import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MemoryCache } from "../src/cache/MemoryCache.js";
import { buildConfig } from "../src/config/env.js";
import { Logger } from "../src/logging/Logger.js";
import type { PaperResult } from "../src/models/Paper.js";
import type { PaperSearchQuery } from "../src/models/Search.js";
import type { AcademicSource } from "../src/models/Source.js";
import { createApp, type App } from "../src/server.js";
import { MockSource, makePaper } from "./helpers/mockSource.js";

/**
 * Concurrency and cancellation-scoping tests against the real HTTP server.
 *
 * The critical property: an AbortController belongs to ONE search request.
 * When user A confirms an exact match, only A's outstanding work is cancelled;
 * user B's unrelated search must run to completion.
 */

const silentLogger = new Logger({ level: "error", sink: () => undefined });

/** Paper A resolves instantly; paper B only after a delay. */
const PAPER_A = makePaper({
  source: "Fast Source",
  doi: "10.1234/paper-a",
  title: "Immediate Multimodal Deepfake Detection Study",
});
const PAPER_B = makePaper({
  source: "Slow Source",
  doi: "10.1234/paper-b",
  title: "Delayed Coral Reef Bleaching Survey Of The Pacific",
});

/**
 * A source that answers different queries with different latency, and records
 * per-query cancellation so cross-request interference is observable.
 */
class RoutingSource implements AcademicSource {
  readonly name: string;
  readonly key: string;
  readonly cancelled: string[] = [];
  readonly completed: string[] = [];
  readonly started: string[] = [];

  constructor(
    name: string,
    key: string,
    private readonly routes: { match: RegExp; paper?: PaperResult; latencyMs: number }[],
  ) {
    this.name = name;
    this.key = key;
  }

  isAvailable(): boolean {
    return true;
  }

  private label(query: PaperSearchQuery): string {
    return query.doi ?? query.title ?? query.keywords?.join(",") ?? query.freeText ?? "?";
  }

  private route(label: string): { paper?: PaperResult; latencyMs: number } | undefined {
    return this.routes.find((r) => r.match.test(label));
  }

  async search(query: PaperSearchQuery, signal?: AbortSignal): Promise<PaperResult[]> {
    const label = this.label(query);
    this.started.push(label);
    const route = this.route(label);
    const latency = route?.latencyMs ?? 0;

    if (latency > 0) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          clearTimeout(timer);
          this.cancelled.push(label);
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        const timer = setTimeout(() => {
          // The listener MUST be removed once the call completes, otherwise a
          // later abort of the (already finished) request would be recorded as
          // a spurious cancellation.
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, latency);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (signal?.aborted) {
      this.cancelled.push(label);
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }

    this.completed.push(label);
    return route?.paper ? [structuredClone(route.paper)] : [];
  }

  async getByDOI(doi: string, signal?: AbortSignal): Promise<PaperResult | null> {
    const results = await this.search({ doi }, signal);
    return results[0] ?? null;
  }
}

let app: App;
let baseUrl: string;
let fast: RoutingSource;
let slow: RoutingSource;

beforeAll(async () => {
  const config = buildConfig({
    NODE_ENV: "test",
    SOURCE_PRIORITY: "doaj,pubmed",
    FALLBACK_SOURCE_PRIORITY: "crossref",
    SIMILAR_SOURCE_PRIORITY: "semanticScholar",
    CACHE_TTL_SECONDS: "0",
    // Keep the limiter out of the way; this suite is about cancellation scope.
    DEFAULT_REQUESTS_PER_SECOND: "50",
    DEFAULT_MAX_CONCURRENCY: "8",
  });

  app = createApp({
    config,
    logger: silentLogger,
    cache: new MemoryCache({ defaultTtlSeconds: 0, maxEntries: 100 }),
    fetchImpl: (async () => {
      throw new Error("A test attempted a real network request");
    }) as typeof fetch,
  });

  // "doaj" answers A instantly and knows nothing about B.
  fast = new RoutingSource("Fast Source", "doaj", [
    { match: /paper-a|Immediate/i, paper: PAPER_A, latencyMs: 0 },
  ]);
  // "pubmed" is slow for everything; A's match should cancel A's call here,
  // while B's call on the same source must survive.
  slow = new RoutingSource("Slow Source", "pubmed", [
    { match: /paper-b|Delayed/i, paper: PAPER_B, latencyMs: 500 },
    { match: /.*/, latencyMs: 500 },
  ]);

  app.registry.register("doaj", fast);
  app.registry.register("pubmed", slow);
  app.registry.register("crossref", new MockSource({ name: "Fallback", key: "crossref", results: [] }));
  app.registry.register("semanticScholar", new MockSource({ name: "Similar", key: "semanticScholar", related: [] }));

  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
});

async function search(body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/api/papers/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe("per-request cancellation scoping", () => {
  it("user A's exact match does not cancel user B's unrelated search", async () => {
    // A resolves immediately from the fast source and aborts its own
    // controller; B depends on the slow source and must still complete.
    const [a, b] = await Promise.all([
      search({ doi: "10.1234/paper-a" }),
      search({ doi: "10.1234/paper-b" }),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    // User A: found and stopped early.
    expect(a.body.exactPaper?.doi).toBe("10.1234/paper-a");
    expect(a.body.exactPaper?.matchType).toBe("exact");
    expect(a.body.stoppedEarly).toBe(true);

    // User B: NOT collateral damage - its own search completed normally.
    expect(b.body.exactPaper?.doi).toBe("10.1234/paper-b");
    expect(b.body.exactPaper?.matchType).toBe("exact");
    expect(b.body.searchCompleted).toBe(true);

    // The slow source did run B's query to completion.
    expect(slow.completed.some((l) => /paper-b/.test(l))).toBe(true);
    // Any cancellation it saw was A's, never B's.
    expect(slow.cancelled.some((l) => /paper-b/.test(l))).toBe(false);
  });

  it("keeps ten concurrent searches independent and correct", async () => {
    const requests = Array.from({ length: 10 }, (_, i) =>
      search(i % 2 === 0 ? { doi: "10.1234/paper-a" } : { doi: "10.1234/paper-b" }),
    );
    const results = await Promise.all(requests);

    expect(results.every((r) => r.status === 200)).toBe(true);
    results.forEach((r, i) => {
      const expected = i % 2 === 0 ? "10.1234/paper-a" : "10.1234/paper-b";
      // No cross-talk: each response carries its own paper.
      expect(r.body.exactPaper?.doi, `request ${i}`).toBe(expected);
      expect(r.body.query.doi, `request ${i}`).toBe(expected);
    });
  });

  it("stays responsive and returns valid JSON under a concurrent burst", async () => {
    const mixed = await Promise.all([
      search({ doi: "10.1234/paper-a" }),
      search({ title: "Immediate Multimodal Deepfake Detection Study" }),
      search({ keywords: ["deepfake", "audio"] }),
      search({}), // invalid on purpose
      fetch(`${baseUrl}/health`).then(async (r) => ({ status: r.status, body: await r.json() })),
    ]);

    expect(mixed[0]!.status).toBe(200);
    expect(mixed[1]!.status).toBe(200);
    expect(mixed[2]!.status).toBe(200);
    expect(mixed[3]!.status).toBe(400); // one bad request does not affect the rest
    expect(mixed[4]!.status).toBe(200);
    expect((mixed[4]!.body as { status: string }).status).toBe("ok");
  });

  it("aborts a search when the client disconnects, without disturbing others", async () => {
    const controller = new AbortController();
    const abandoned = fetch(`${baseUrl}/api/papers/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ doi: "10.1234/paper-b" }),
      signal: controller.signal,
    }).catch((error: Error) => error);

    // Cancel mid-flight, while the slow source is still working.
    await new Promise((resolve) => setTimeout(resolve, 80));
    controller.abort();
    await abandoned;

    // A concurrent, well-behaved request still succeeds afterwards.
    const healthy = await search({ doi: "10.1234/paper-a" });
    expect(healthy.status).toBe(200);
    expect(healthy.body.exactPaper?.doi).toBe("10.1234/paper-a");

    // And the server is still serving.
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
  });
});

describe("cache behaviour across requests", () => {
  it("does not leak mutations between requests sharing a cached result", async () => {
    const first = await search({ doi: "10.1234/paper-a" });
    const second = await search({ doi: "10.1234/paper-a" });

    expect(first.body.exactPaper.title).toBe(second.body.exactPaper.title);
    expect(first.body.exactPaper.doi).toBe(second.body.exactPaper.doi);
    expect(first.body.exactPaper.matchType).toBe(second.body.exactPaper.matchType);
    // Confidence must be recomputed identically, not accumulated.
    expect(first.body.exactPaper.confidence).toBe(second.body.exactPaper.confidence);
    expect(Array.isArray(second.body.exactPaper.sources)).toBe(true);
    expect(second.body.exactPaper.sources).toEqual(first.body.exactPaper.sources);
  });
});
