import { describe, expect, it, vi } from "vitest";

import { MemoryCache } from "../src/cache/MemoryCache.js";
import { buildConfig } from "../src/config/env.js";
import { SourceRegistry } from "../src/config/sources.js";
import { Logger } from "../src/logging/Logger.js";
import type { PaperResult } from "../src/models/Paper.js";
import { MatchEngine, isDistinctiveTitle } from "../src/search/MatchEngine.js";
import { normalizeQuery } from "../src/search/QueryBuilder.js";
import { SearchOrchestrator, isDiscoveryQuery } from "../src/search/SearchOrchestrator.js";
import { RateLimiter, RateLimitExceededError } from "../src/rateLimit/RateLimiter.js";
import { RetryPolicy, delay, positiveDelay } from "../src/rateLimit/RetryPolicy.js";
import { HttpError } from "../src/http/HttpError.js";
import { recencyBonus, withinYearRange } from "../src/search/RankingEngine.js";
import { stripMarkup } from "../src/utils/normalizeTitle.js";
import { validateSearchRequest } from "../src/security/InputValidator.js";
import { MockSource, makePaper } from "./helpers/mockSource.js";
import type { FullTextResult } from "../src/models/FullText.js";

/**
 * Regression tests for bugs found by exercising the running server against the
 * live academic APIs. Each block names the failure that was actually observed.
 */

const config = buildConfig({ NODE_ENV: "test" });
const matchEngine = new MatchEngine(config);
const silentLogger = new Logger({ level: "error", sink: () => undefined });

function paper(overrides: Partial<PaperResult> = {}): PaperResult {
  return {
    title: "Attention Is All You Need",
    authors: ["Ashish Vaswani", "Noam Shazeer"],
    source: "arXiv",
    matchType: "keyword",
    confidence: 0,
    ...overrides,
  };
}

function buildOrchestrator(sources: MockSource[]): SearchOrchestrator {
  const cfg = buildConfig({
    NODE_ENV: "test",
    SOURCE_PRIORITY: sources.map((s) => s.key).join(","),
    FALLBACK_SOURCE_PRIORITY: "crossref",
    SIMILAR_SOURCE_PRIORITY: "semanticScholar",
    CACHE_TTL_SECONDS: "0",
  });
  const registry = new SourceRegistry({
    config: cfg,
    cache: new MemoryCache({ defaultTtlSeconds: 0, maxEntries: 10 }),
    logger: silentLogger,
    fetchImpl: (async () => {
      throw new Error("A test attempted a real network request");
    }) as typeof fetch,
  });
  for (const source of sources) registry.register(source.key, source);
  for (const key of registry.keys()) {
    if (!sources.some((s) => s.key === key)) registry.register(key, new MockSource({ name: key, key, results: [] }));
  }
  return new SearchOrchestrator({ registry, config: cfg, logger: silentLogger });
}

/* ------------------------------------------------------------------ */
/* BUG 1: a title-only search could never reach "exact"                */
/* ------------------------------------------------------------------ */
describe("regression: title-only query scoring", () => {
  it("confirms an exact match for a title-only query with an identical title", () => {
    // Observed live: matchType "similar", confidence 0.615, no early stop,
    // 27s spent querying all seven sources including the fallbacks.
    // Cause: author/year/venue/keyword components were scored 0 when the user
    // supplied nothing to compare on, capping a perfect title match at ~0.62.
    const query = normalizeQuery({ title: "Attention Is All You Need" });
    const verdict = matchEngine.evaluate(query, paper());

    expect(verdict.score.titleScore).toBe(1);
    expect(verdict.score.finalScore).toBe(1);
    expect(verdict.matchType).toBe("exact");
    expect(verdict.isExactMatch).toBe(true);
    expect(verdict.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it("normalizes case, spacing and punctuation before matching", () => {
    for (const title of [
      "attention is all you need",
      "  ATTENTION   IS  ALL   YOU  NEED ",
      "Attention Is All You Need!!",
    ]) {
      expect(matchEngine.evaluate(normalizeQuery({ title }), paper()).isExactMatch, title).toBe(true);
    }
  });

  it("excludes an inapplicable component instead of scoring it zero", () => {
    const withYear = matchEngine.evaluate(
      normalizeQuery({ title: "Attention Is All You Need" }),
      paper({ year: 2017 }),
    );
    const noYear = matchEngine.evaluate(normalizeQuery({ title: "Attention Is All You Need" }), paper());
    expect(withYear.score.finalScore).toBe(noYear.score.finalScore);
  });

  it("still refuses a short generic title, which identifies nothing", () => {
    const verdict = matchEngine.evaluate(normalizeQuery({ title: "Editorial" }), paper({ title: "Editorial" }));
    expect(verdict.isExactMatch).toBe(false);
    expect(isDistinctiveTitle("editorial")).toBe(false);
    expect(isDistinctiveTitle("attention is all you need")).toBe(true);
  });

  it("still refuses a merely similar title", () => {
    const verdict = matchEngine.evaluate(
      normalizeQuery({ title: "Attention Is All You Need" }),
      paper({ title: "Attention Is Not All You Need For Inference" }),
    );
    expect(verdict.isExactMatch).toBe(false);
  });

  it("still lets a conflicting year block an otherwise identical title", () => {
    const query = normalizeQuery({ title: "Attention Is All You Need (2017)" });
    const verdict = matchEngine.evaluate(query, paper({ title: "Attention Is All You Need (2017)", year: 1999 }));
    expect(verdict.score.yearScore).toBe(0);
    expect(verdict.isExactMatch).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* BUG 2: keyword/author-only searches returned nothing usable         */
/* ------------------------------------------------------------------ */
describe("regression: discovery queries (keywords / authors only)", () => {
  it("classifies a title-less query as discovery", () => {
    expect(isDiscoveryQuery(normalizeQuery({ keywords: ["deepfake"] }))).toBe(true);
    expect(isDiscoveryQuery(normalizeQuery({ authors: ["John Doe"] }))).toBe(true);
    expect(isDiscoveryQuery(normalizeQuery({ title: "x" }))).toBe(false);
    expect(isDiscoveryQuery(normalizeQuery({ doi: "10.1234/x" }))).toBe(false);
  });

  it("never promotes a keyword or author query to exact or near-exact", () => {
    const kw = matchEngine.evaluate(
      normalizeQuery({ keywords: ["attention", "need"] }),
      paper({ keywords: ["attention", "need"] }),
    );
    expect(kw.isExactMatch).toBe(false);
    expect(["keyword", "similar"]).toContain(kw.matchType);

    const au = matchEngine.evaluate(normalizeQuery({ authors: ["Ashish Vaswani"] }), paper());
    expect(au.isExactMatch).toBe(false);
    expect(["keyword", "similar"]).toContain(au.matchType);
  });

  it("returns ranked, deduplicated results instead of an empty response", async () => {
    // Observed live: an authors-only search saw 65 candidates and returned
    // exactPaper: null with similarPapers: [] - the entire result set was lost.
    const byAuthor = Array.from({ length: 12 }, (_, i) =>
      makePaper({
        source: "Mock",
        doi: `10.1234/p${i}`,
        title: `A Study of Transformers Number ${i}`,
        authors: ["Ashish Vaswani"],
        keywords: ["transformers"],
      }),
    );
    // The same paper from a second source must collapse into one entry.
    const duplicate = { ...byAuthor[0]!, source: "Mock Two" };

    const orchestrator = buildOrchestrator([
      new MockSource({ name: "Mock", key: "doaj", results: [...byAuthor, duplicate] }),
    ]);

    const response = await orchestrator.findPaper({ authors: ["Ashish Vaswani"] });

    expect(response.exactPaper).toBeNull(); // no fabricated identification
    expect(response.similarPapers.length).toBeGreaterThan(0);
    expect(response.similarPapers.length).toBeLessThanOrEqual(config.budget.maxSimilarPapers);
    expect(response.similarPapers.every((p) => typeof p.similarityScore === "number")).toBe(true);

    const scores = response.similarPapers.map((p) => p.similarityScore!);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores); // ranked

    const dois = response.similarPapers.map((p) => p.doi);
    expect(new Set(dois).size).toBe(dois.length); // deduplicated
    expect(response.notes?.some((n) => /most relevant results/i.test(n))).toBe(true);
  });

  it("keeps returning a plain not-found for a TITLE query that matches nothing", async () => {
    // A named title is an identification attempt; failing it must not dump
    // unrelated candidates into the response.
    const orchestrator = buildOrchestrator([
      new MockSource({
        name: "Mock",
        key: "doaj",
        results: [makePaper({ doi: "10.1234/unrelated", title: "Coral Reef Bleaching Patterns" })],
      }),
    ]);

    const response = await orchestrator.findPaper({ title: "A Title Nothing Will Ever Match Xyzzy" });
    expect(response.exactPaper).toBeNull();
    expect(response.similarPapers).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* BUG 3: double-encoded HTML entities survived into titles            */
/* ------------------------------------------------------------------ */
describe("regression: double-encoded entities", () => {
  it("decodes the double-encoded titles Crossref actually returns", () => {
    // Verified against the live Crossref payload for 10.2139/ssrn.5391101.
    expect(stripMarkup("Audio &amp;amp; Video Deepfake Detection")).toBe("Audio & Video Deepfake Detection");
  });

  it("still decodes single-encoded entities and strips revealed tags", () => {
    expect(stripMarkup("Hello &amp; welcome")).toBe("Hello & welcome");
    expect(stripMarkup("<jats:p>In &lt;i&gt;vivo&lt;/i&gt; studies</jats:p>")).toBe("In vivo studies");
    expect(stripMarkup("A &#8212; B")).toBe("A — B");
    expect(stripMarkup("A &#x2014; B")).toBe("A — B");
  });

  it("terminates on adversarially nested encoding", () => {
    const nasty = "&" + "amp;".repeat(50) + "x";
    expect(() => stripMarkup(nasty)).not.toThrow();
    expect(stripMarkup(nasty).length).toBeLessThan(nasty.length);
  });
});

/* ------------------------------------------------------------------ */
/* BUG 4: unref'd timers let the process exit with promises pending    */
/* ------------------------------------------------------------------ */
describe("regression: pending waits must hold the event loop open", () => {
  it("does not unref the rate limiter pump timer", async () => {
    // Observed: running an adapter outside the HTTP server (arXiv, 1 req/3s)
    // exited with "Detected unsettled top-level await". The pump timer was
    // unref'd, so with no server socket holding the loop open Node exited
    // before the queued waiter could ever be resolved.
    const timers: NodeJS.Timeout[] = [];
    const limiter = new RateLimiter({
      name: "probe",
      requestsPerSecond: 50,
      maxConcurrency: 1,
      maxRetries: 0,
      setTimeoutFn: (handler, ms) => {
        const timer = setTimeout(handler, ms);
        timers.push(timer);
        return timer;
      },
    });

    // Three tasks against one token forces at least one queued wait.
    await Promise.all([0, 1, 2].map(() => limiter.schedule(async () => undefined)));

    expect(timers.length).toBeGreaterThan(0);
    for (const timer of timers) {
      // A timer that has already fired reports hasRef() === false; what must
      // never happen is a *pending* timer being unref'd.
      expect(typeof timer.hasRef).toBe("function");
    }
    // Directly assert the scheduling path leaves the timer referenced.
    const pending: NodeJS.Timeout[] = [];
    const limiter2 = new RateLimiter({
      name: "probe2",
      requestsPerSecond: 1,
      maxConcurrency: 1,
      maxRetries: 0,
      setTimeoutFn: (handler, ms) => {
        const timer = setTimeout(handler, ms);
        pending.push(timer);
        return timer;
      },
    });
    await limiter2.acquire();
    limiter2.release();
    const queued = limiter2.schedule(async () => "done");
    await new Promise((resolve) => setImmediate(resolve));
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0]!.hasRef()).toBe(true); // would be false before the fix
    limiter2.drain();
    await expect(queued).rejects.toThrow();
  });

  it("does not unref the retry backoff timer", async () => {
    const created: NodeJS.Timeout[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((handler: TimerHandler, ms?: number, ...rest: unknown[]) => {
        const timer = (realSetTimeout as typeof setTimeout)(handler as () => void, ms, ...rest);
        created.push(timer);
        return timer;
      }) as typeof setTimeout);

    try {
      const waiting = delay(40);
      expect(created.length).toBeGreaterThan(0);
      expect(created[0]!.hasRef()).toBe(true); // would be false before the fix
      await waiting;
    } finally {
      spy.mockRestore();
    }
  });
});

/* ------------------------------------------------------------------ */
/* BUG 5: Retry-After: 0 on a 429 caused an IMMEDIATE retry            */
/* ------------------------------------------------------------------ */
describe("regression: a 429 is never retried immediately", () => {
  const retryConfig = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30_000, jitter: false };

  it("ignores a non-positive Retry-After and backs off instead", () => {
    const policy = new RetryPolicy(retryConfig);
    const zero = policy.decide(new HttpError("429", { kind: "http", status: 429, retryAfterMs: 0 }), 0);

    expect(zero.shouldRetry).toBe(true);
    expect(zero.delayMs).toBe(1000); // backoff, not 0
    expect(zero.providerDirected).toBe(false);
  });

  it("still honours a positive Retry-After", () => {
    const policy = new RetryPolicy(retryConfig);
    const directed = policy.decide(new HttpError("429", { kind: "http", status: 429, retryAfterMs: 4000 }), 0);
    expect(directed).toMatchObject({ shouldRetry: true, delayMs: 4000, providerDirected: true });
  });

  it("applies the same rule to a 503 Retry-After", () => {
    const policy = new RetryPolicy(retryConfig);
    const zero = policy.decide(new HttpError("503", { kind: "http", status: 503, retryAfterMs: 0 }), 0);
    expect(zero.delayMs).toBe(1000);
    expect(zero.providerDirected).toBe(false);
  });

  it("treats only a strictly positive delay as guidance", () => {
    expect(positiveDelay(0)).toBeUndefined();
    expect(positiveDelay(-5)).toBeUndefined();
    expect(positiveDelay(undefined)).toBeUndefined();
    expect(positiveDelay(Number.NaN)).toBeUndefined();
    expect(positiveDelay(250)).toBe(250);
  });
});

/* ------------------------------------------------------------------ */
/* BUG 6: a long provider cooldown blocked every later request forever */
/* ------------------------------------------------------------------ */
describe("regression: a rate-limited source must never block the search", () => {
  it("fails fast instead of queueing behind a multi-hour cooldown", async () => {
    // Observed live: OpenAlex answers 429 with `Retry-After: 45075` (12.5h)
    // once its free daily quota is spent. We honoured it literally, so every
    // later request queued behind a 12.5-hour wait and the whole search hung
    // until the CLIENT gave up - a 5-minute request that returned nothing.
    const limiter = new RateLimiter({
      name: "openalex",
      requestsPerSecond: 5,
      maxConcurrency: 2,
      maxRetries: 0,
    });

    limiter.applyCooldown(45_075_000); // 12.5 hours, exactly as observed
    expect(limiter.projectedWaitMs()).toBeGreaterThan(45_000_000);

    const startedAt = Date.now();
    await expect(limiter.acquire(undefined, 15_000)).rejects.toBeInstanceOf(RateLimitExceededError);
    // It must reject immediately, not wait.
    expect(Date.now() - startedAt).toBeLessThan(500);

    // The cooldown itself is still respected - we simply do not block on it.
    expect(limiter.cooldownRemainingMs).toBeGreaterThan(45_000_000);
  });

  it("carries the retry ETA so the source status can explain itself", async () => {
    const limiter = new RateLimiter({ name: "openalex", requestsPerSecond: 5, maxConcurrency: 1, maxRetries: 0 });
    limiter.applyCooldown(45_075_000);
    try {
      await limiter.acquire(undefined, 1000);
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitExceededError);
      expect((error as RateLimitExceededError).retryAfterMs).toBeGreaterThan(45_000_000);
      expect((error as RateLimitExceededError).source).toBe("openalex");
    }
  });

  it("still waits normally for a short, affordable cooldown", async () => {
    const limiter = new RateLimiter({ name: "s", requestsPerSecond: 100, maxConcurrency: 1, maxRetries: 0 });
    limiter.applyCooldown(120);
    const startedAt = Date.now();
    await limiter.acquire(undefined, 5000); // well within budget -> waits
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90);
  });

  it("does not fail fast when no budget is given", async () => {
    const limiter = new RateLimiter({ name: "s", requestsPerSecond: 100, maxConcurrency: 1, maxRetries: 0 });
    limiter.applyCooldown(80);
    await expect(limiter.acquire()).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Recency filtering and preference                                    */
/* ------------------------------------------------------------------ */
describe("recency filtering", () => {
  it("accepts and validates a year range", () => {
    expect(validateSearchRequest({ keywords: ["x"], fromYear: 2020 }).fromYear).toBe(2020);
    expect(validateSearchRequest({ keywords: ["x"], toYear: "2024" }).toYear).toBe(2024);
    expect(() => validateSearchRequest({ keywords: ["x"], fromYear: 2024, toYear: 2020 })).toThrow(
      /must not be greater/,
    );
    expect(() => validateSearchRequest({ keywords: ["x"], fromYear: "abc" })).toThrow(/4-digit year/);
    expect(() => validateSearchRequest({ keywords: ["x"], fromYear: 1200 })).toThrow(/between/);
  });

  it("keeps only papers inside the range, and excludes unknown years", () => {
    expect(withinYearRange(2022, 2020, 2024)).toBe(true);
    expect(withinYearRange(2019, 2020, 2024)).toBe(false);
    expect(withinYearRange(2025, 2020, 2024)).toBe(false);
    expect(withinYearRange(2022, undefined, undefined)).toBe(true);
    // Unknown year with no filter is kept; with a filter it cannot be verified.
    expect(withinYearRange(undefined, undefined, undefined)).toBe(true);
    expect(withinYearRange(undefined, 2020, undefined)).toBe(false);
  });

  it("nudges recent papers up without overturning relevance", () => {
    const now = new Date().getFullYear();
    expect(recencyBonus(now, 0.05)).toBeCloseTo(0.05);
    expect(recencyBonus(now - 6, 0.05)).toBeGreaterThan(0);
    expect(recencyBonus(now - 6, 0.05)).toBeLessThan(0.05);
    expect(recencyBonus(now - 30, 0.05)).toBe(0);
    expect(recencyBonus(undefined, 0.05)).toBe(0);
    // Disabling it is exact.
    expect(recencyBonus(now, 0)).toBe(0);
    // The nudge can never outweigh a real relevance gap.
    expect(recencyBonus(now, 0.05)).toBeLessThan(0.1);
  });
});

/* ------------------------------------------------------------------ */
/* BUG 7: open-access papers came back with NO pdfUrl                  */
/* ------------------------------------------------------------------ */
describe("regression: full-text resolution must not depend on which source found the paper", () => {
  /** A source that finds the paper but knows nothing about full text. */
  function metadataOnlySource(key: string, paper: PaperResult): MockSource {
    return new MockSource({
      name: `Meta-${key}`,
      key,
      results: [paper],
      byDoi: { [paper.doi!]: paper },
      fullText: null,
    });
  }

  /** An OA index that has the PDF but never appears in search results. */
  function oaIndexSource(key: string, pdfUrl: string): MockSource {
    const source = new MockSource({ name: `OA-${key}`, key, results: [] });
    const fullText: FullTextResult = {
      available: true,
      url: pdfUrl,
      type: "pdf",
      accessType: "open-access",
      source: `OA-${key}`,
    };
    source.getFullText = async () => fullText;
    return source;
  }

  it("finds the PDF from an OA index even though another source found the paper", async () => {
    // Observed live: DOAJ found a PLOS paper and reported isOpenAccess true,
    // but the record carried only a doi.org link, so pdfUrl was undefined.
    // The resolver only asked sources that "knew" the paper, so the OA index
    // holding the actual PDF was never consulted.
    const paper = makePaper({
      source: "Meta-doaj",
      doi: "10.1371/journal.pone.0266462",
      title: "Blockchain technology in healthcare",
      isOpenAccess: true,
      landingPageUrl: "https://doi.org/10.1371/journal.pone.0266462",
    });
    delete paper.pdfUrl;

    const cfg = buildConfig({
      NODE_ENV: "test",
      SOURCE_PRIORITY: "doaj",
      FALLBACK_SOURCE_PRIORITY: "crossref",
      EXTENDED_SOURCE_PRIORITY: "datacite",
      SIMILAR_SOURCE_PRIORITY: "semanticScholar",
      FULLTEXT_SOURCE_PRIORITY: "europepmc",
      CACHE_TTL_SECONDS: "0",
    });
    const registry = new SourceRegistry({
      config: cfg,
      cache: new MemoryCache({ defaultTtlSeconds: 0, maxEntries: 10 }),
      logger: silentLogger,
      fetchImpl: (async () => {
        throw new Error("A test attempted a real network request");
      }) as typeof fetch,
    });
    registry.register("doaj", metadataOnlySource("doaj", paper));
    registry.register("europepmc", oaIndexSource("europepmc", "https://journals.plos.org/a.pdf"));
    for (const key of ["crossref", "datacite", "semanticScholar"]) {
      registry.register(key, new MockSource({ name: key, key, results: [] }));
    }

    const orchestrator = new SearchOrchestrator({ registry, config: cfg, logger: silentLogger });
    const response = await orchestrator.findPaper({ doi: "10.1371/journal.pone.0266462" });

    expect(response.exactPaper).not.toBeNull();
    expect(response.fullText).toMatchObject({ type: "pdf", accessType: "open-access" });
    expect(response.fullText?.url).toBe("https://journals.plos.org/a.pdf");
    // The PDF must also be on the paper itself, not only in `fullText`.
    expect(response.exactPaper?.pdfUrl).toBe("https://journals.plos.org/a.pdf");
    expect(response.exactPaper?.isOpenAccess).toBe(true);
  });

  it("never invents a PDF for a paywalled paper", async () => {
    const paper = makePaper({
      source: "Meta-doaj",
      doi: "10.1038/nature14539",
      title: "A Closed Access Paper",
      isOpenAccess: false,
      landingPageUrl: "https://www.nature.com/articles/nature14539",
    });
    delete paper.pdfUrl;

    const cfg = buildConfig({
      NODE_ENV: "test",
      SOURCE_PRIORITY: "doaj",
      FALLBACK_SOURCE_PRIORITY: "crossref",
      EXTENDED_SOURCE_PRIORITY: "datacite",
      SIMILAR_SOURCE_PRIORITY: "semanticScholar",
      FULLTEXT_SOURCE_PRIORITY: "europepmc",
      CACHE_TTL_SECONDS: "0",
    });
    const registry = new SourceRegistry({
      config: cfg,
      cache: new MemoryCache({ defaultTtlSeconds: 0, maxEntries: 10 }),
      logger: silentLogger,
      fetchImpl: (async () => {
        throw new Error("A test attempted a real network request");
      }) as typeof fetch,
    });
    registry.register("doaj", metadataOnlySource("doaj", paper));
    // The OA index has nothing for this DOI - the honest answer.
    const closed = new MockSource({ name: "OA-europepmc", key: "europepmc", results: [] });
    closed.getFullText = async () => null;
    registry.register("europepmc", closed);
    for (const key of ["crossref", "datacite", "semanticScholar"]) {
      registry.register(key, new MockSource({ name: key, key, results: [] }));
    }

    const orchestrator = new SearchOrchestrator({ registry, config: cfg, logger: silentLogger });
    const response = await orchestrator.findPaper({ doi: "10.1038/nature14539" });

    expect(response.exactPaper?.pdfUrl).toBeUndefined();
    expect(response.fullText?.type).not.toBe("pdf");
    expect(response.fullText?.accessType).toBe("landing-page");
    expect(response.fullText?.url).toBe("https://www.nature.com/articles/nature14539");
  });
});
