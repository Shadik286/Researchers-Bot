import { describe, expect, it } from "vitest";

import { MemoryCache } from "../src/cache/MemoryCache.js";
import { buildConfig, type AppConfig } from "../src/config/env.js";
import { SourceRegistry } from "../src/config/sources.js";
import { Logger } from "../src/logging/Logger.js";
import { SearchOrchestrator, mergeStatuses, pickBestFullText } from "../src/search/SearchOrchestrator.js";
import { MockSource, makePaper } from "./helpers/mockSource.js";

/**
 * Integration tests for the orchestration pipeline.
 *
 * Every source here is a MockSource. No network call is made, and the real
 * adapters are constructed only so the registry is realistic - they are then
 * replaced by mocks before any search runs.
 */

const silentLogger = new Logger({ level: "error", sink: () => undefined });

const refuseFetch = (async () => {
  throw new Error("A test attempted a real network request");
}) as typeof fetch;

interface HarnessOptions {
  primary: MockSource[];
  fallback?: MockSource[];
  extended?: MockSource[];
  similar?: MockSource[];
  env?: Record<string, string>;
}

function buildHarness({ primary, fallback = [], extended = [], similar = [], env = {} }: HarnessOptions): {
  orchestrator: SearchOrchestrator;
  config: AppConfig;
} {
  const config = buildConfig({
    NODE_ENV: "test",
    SOURCE_PRIORITY: primary.map((s) => s.key).join(","),
    FALLBACK_SOURCE_PRIORITY: fallback.map((s) => s.key).join(",") || "crossref",
    EXTENDED_SOURCE_PRIORITY: extended.map((s) => s.key).join(",") || "europepmc",
    MAX_EXTENDED_SOURCES: String(Math.max(extended.length, 1)),
    SIMILAR_SOURCE_PRIORITY: similar.map((s) => s.key).join(",") || "semanticScholar",
    MAX_FALLBACK_SOURCES: String(Math.max(fallback.length, 1)),
    CACHE_TTL_SECONDS: "0",
    ...env,
  });

  const registry = new SourceRegistry({
    config,
    cache: new MemoryCache({ defaultTtlSeconds: 0, maxEntries: 10 }),
    logger: silentLogger,
    fetchImpl: refuseFetch,
  });

  // Replace whatever the registry built with the controlled mocks.
  for (const source of [...primary, ...fallback, ...extended, ...similar]) {
    registry.register(source.key, source);
  }
  // Drop any real adapter the config pulled in but the test does not use.
  for (const key of registry.keys()) {
    const used = [...primary, ...fallback, ...extended, ...similar].some((s) => s.key === key);
    if (!used) registry.register(key, new MockSource({ name: key, key, results: [] }));
  }

  return { orchestrator: new SearchOrchestrator({ registry, config, logger: silentLogger }), config };
}

describe("SearchOrchestrator - exact match stops the main-paper search", () => {
  it("stops after source C finds the paper, cancels the rest, skips fallback, and still runs the similar phase", async () => {
    const target = makePaper({ source: "Source C", doi: "10.1234/example" });
    const similarPapers = Array.from({ length: 12 }, (_, i) =>
      makePaper({
        source: "Similarity",
        doi: `10.1234/similar-${i}`,
        title: `Multimodal Deepfake Detection Variant ${i}`,
      }),
    );

    // A and B answer slowly and find nothing; C answers quickly with the paper.
    const sourceA = new MockSource({ name: "Source A", key: "doaj", results: [], latencyMs: 40 });
    const sourceB = new MockSource({ name: "Source B", key: "pubmed", results: [], latencyMs: 40 });
    const sourceC = new MockSource({ name: "Source C", key: "core", results: [target] });

    const crossref = new MockSource({ name: "Crossref", key: "crossref", results: [target] });
    const openalex = new MockSource({ name: "OpenAlex", key: "openalex", results: [target] });

    const similarity = new MockSource({
      name: "Similarity",
      key: "semanticScholar",
      related: similarPapers,
    });

    const { orchestrator } = buildHarness({
      primary: [sourceA, sourceB, sourceC],
      fallback: [crossref, openalex],
      similar: [similarity],
    });

    const response = await orchestrator.findPaper({
      title: "Deepfake Detection Using Audio and Video",
      authors: ["John Doe"],
    });

    // 1. Source C identified the exact paper.
    expect(response.exactPaper).not.toBeNull();
    expect(response.exactPaper!.source).toBe("Source C");
    expect(response.exactPaper!.matchType).toBe("exact");
    expect(response.exactPaper!.confidence).toBeGreaterThanOrEqual(0.95);

    // 2. The search reports that it stopped early.
    expect(response.stoppedEarly).toBe(true);
    expect(response.notes?.some((n) => /cancelled/i.test(n))).toBe(true);

    // 3. No further main-paper variants were issued after the match.
    expect(sourceA.searchCallCount).toBe(1);
    expect(sourceB.searchCallCount).toBe(1);
    expect(sourceC.searchCallCount).toBe(1);

    // 4. Fallback sources were never queried for MAIN-PAPER discovery.
    expect(crossref.searchCallCount).toBe(0);
    expect(openalex.searchCallCount).toBe(0);

    // 5. The similar-paper phase still ran afterwards.
    expect(similarity.calls.some((c) => c.method === "getRelated")).toBe(true);
    expect(response.similarPapers.length).toBeGreaterThanOrEqual(8);
    expect(response.similarPapers.length).toBeLessThanOrEqual(10);
    expect(response.similarPapers.every((p) => p.doi !== target.doi)).toBe(true);
    expect(response.searchCompleted).toBe(true);
  });

  it("cancels a slow in-flight source once a faster one confirms the match", async () => {
    const target = makePaper({ source: "Fast", doi: "10.1234/example" });
    const slow = new MockSource({ name: "Slow", key: "doaj", results: [], latencyMs: 500 });
    const fast = new MockSource({
      name: "Fast",
      key: "core",
      results: [target],
      byDoi: { "10.1234/example": target },
    });

    const { orchestrator } = buildHarness({
      primary: [slow, fast],
      similar: [new MockSource({ name: "Sim", key: "semanticScholar", related: [] })],
    });

    const started = Date.now();
    const response = await orchestrator.findPaper({ doi: "10.1234/example" });
    const elapsed = Date.now() - started;

    expect(response.exactPaper?.source).toBe("Fast");
    expect(response.stoppedEarly).toBe(true);

    // The slow source was cut off mid-request, not awaited to completion.
    expect(slow.cancelledCalls).toHaveLength(1);
    expect(elapsed).toBeLessThan(400);

    const slowStatus = response.sourcesChecked.find((s) => s.name === "Slow");
    expect(slowStatus?.status).toBe("skipped");
    expect(slowStatus?.error).toBe("cancelled");
  });
});

describe("SearchOrchestrator - DOI strategy", () => {
  it("uses the dedicated DOI endpoint and stops immediately on a hit", async () => {
    const target = makePaper({ source: "DOI Source", doi: "10.1234/example" });
    const doiSource = new MockSource({
      name: "DOI Source",
      key: "doaj",
      byDoi: { "10.1234/example": target },
    });
    const other = new MockSource({ name: "Other", key: "core", results: [] });

    const { orchestrator } = buildHarness({
      primary: [doiSource, other],
      similar: [new MockSource({ name: "Sim", key: "semanticScholar", related: [] })],
    });

    const response = await orchestrator.findPaper({ doi: "https://doi.org/10.1234/EXAMPLE" });

    expect(doiSource.calls[0]!.method).toBe("getByDOI");
    expect(doiSource.calls[0]!.doi).toBe("10.1234/example");
    expect(response.exactPaper?.doi).toBe("10.1234/example");
    expect(response.query.strategy).toBe("doi");
    expect(response.stoppedEarly).toBe(true);
  });
});

describe("SearchOrchestrator - fallback behaviour", () => {
  it("queries the fallback sources only when the primaries found nothing", async () => {
    const target = makePaper({ source: "Crossref", doi: "10.1234/example" });

    const primaryA = new MockSource({ name: "A", key: "doaj", results: [] });
    const primaryB = new MockSource({ name: "B", key: "core", results: [] });
    const crossref = new MockSource({ name: "Crossref", key: "crossref", results: [target] });

    const { orchestrator } = buildHarness({
      primary: [primaryA, primaryB],
      fallback: [crossref],
      similar: [new MockSource({ name: "Sim", key: "semanticScholar", related: [] })],
    });

    const response = await orchestrator.findPaper({
      title: "Deepfake Detection Using Audio and Video",
      authors: ["John Doe"],
    });

    expect(primaryA.searchCallCount).toBeGreaterThan(0);
    expect(crossref.searchCallCount).toBeGreaterThan(0);
    expect(response.exactPaper?.source).toBe("Crossref");
    expect(response.notes?.some((n) => /fallback/i.test(n))).toBe(true);
  });

  it("returns exactPaper: null when nothing matches anywhere", async () => {
    const { orchestrator } = buildHarness({
      primary: [
        new MockSource({ name: "A", key: "doaj", results: [] }),
        new MockSource({ name: "B", key: "core", results: [] }),
      ],
      fallback: [new MockSource({ name: "Crossref", key: "crossref", results: [] })],
      similar: [new MockSource({ name: "Sim", key: "semanticScholar", related: [] })],
    });

    const response = await orchestrator.findPaper({ title: "A Paper That Does Not Exist Anywhere At All" });

    expect(response.success).toBe(true);
    expect(response.exactPaper).toBeNull();
    expect(response.similarPapers).toEqual([]);
    expect(response.searchCompleted).toBe(true);
    expect(response.sourcesChecked.length).toBeGreaterThan(0);
  });
});

describe("SearchOrchestrator - source failures and availability", () => {
  it("continues when one source fails and reports its status honestly", async () => {
    const target = makePaper({ source: "Healthy", doi: "10.1234/example" });

    const broken = new MockSource({ name: "Broken", key: "doaj", failWith: new Error("upstream exploded") });
    const missingKey = new MockSource({
      name: "NeedsKey",
      key: "core",
      available: false,
      unavailableMessage: "CORE_API_KEY is not configured",
    });
    const healthy = new MockSource({ name: "Healthy", key: "arxiv", results: [target] });

    const { orchestrator } = buildHarness({
      primary: [broken, missingKey, healthy],
      similar: [new MockSource({ name: "Sim", key: "semanticScholar", related: [] })],
    });

    const response = await orchestrator.findPaper({
      title: "Deepfake Detection Using Audio and Video",
      authors: ["John Doe"],
    });

    expect(response.exactPaper?.source).toBe("Healthy");

    const statuses = new Map(response.sourcesChecked.map((s) => [s.name, s]));
    expect(statuses.get("Broken")?.status).toBe("failed");
    expect(statuses.get("NeedsKey")?.status).toBe("skipped");
    expect(statuses.get("NeedsKey")?.error).toContain("CORE_API_KEY");
    expect(statuses.get("Healthy")?.status).toBe("success");
    // A skipped source never issued a request.
    expect(missingKey.calls).toHaveLength(0);
  });

  it("reports timing and per-source result counts", async () => {
    const target = makePaper({ source: "A", doi: "10.1234/example" });
    const sourceA = new MockSource({
      name: "A",
      key: "doaj",
      results: [target],
      byDoi: { "10.1234/example": target },
    });

    const { orchestrator } = buildHarness({
      primary: [sourceA],
      similar: [new MockSource({ name: "Sim", key: "semanticScholar", related: [] })],
    });

    const response = await orchestrator.findPaper({ doi: "10.1234/example" });
    expect(response.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(response.sourcesChecked.find((s) => s.name === "A")?.resultCount).toBe(1);
  });
});

describe("SearchOrchestrator - similar-paper stage", () => {
  it("falls back to keyword search when related endpoints return too few", async () => {
    const target = makePaper({ source: "A", doi: "10.1234/example" });
    const thinRelated = Array.from({ length: 2 }, (_, i) =>
      makePaper({ doi: `10.1234/r${i}`, title: `Related ${i}`, source: "Sim" }),
    );
    const searchResults = Array.from({ length: 10 }, (_, i) =>
      makePaper({ doi: `10.1234/s${i}`, title: `Deepfake Detection Study ${i}`, source: "Sim" }),
    );

    const similarity = new MockSource({
      name: "Sim",
      key: "semanticScholar",
      related: thinRelated,
      results: searchResults,
    });

    const { orchestrator } = buildHarness({
      primary: [new MockSource({ name: "A", key: "doaj", byDoi: { "10.1234/example": target } })],
      similar: [similarity],
    });

    const response = await orchestrator.findPaper({ doi: "10.1234/example" });

    expect(similarity.calls.some((c) => c.method === "getRelated")).toBe(true);
    expect(similarity.calls.some((c) => c.method === "search")).toBe(true);
    expect(response.similarPapers.length).toBeGreaterThanOrEqual(8);
  });

  it("de-duplicates similar papers arriving from several sources", async () => {
    const target = makePaper({ source: "A", doi: "10.1234/example" });
    const shared = makePaper({ doi: "10.1234/shared", title: "A Shared Related Paper", source: "SimOne" });

    const one = new MockSource({ name: "SimOne", key: "semanticScholar", related: [shared] });
    // Built via makePaper (not a spread) so `sources` stays consistent with
    // `source`, exactly as a real adapter's buildPaper() output would be.
    const sharedFromTwo = makePaper({
      doi: "10.1234/shared",
      title: "A Shared Related Paper",
      source: "SimTwo",
    });
    const two = new MockSource({ name: "SimTwo", key: "openalex", related: [sharedFromTwo] });

    const { orchestrator } = buildHarness({
      primary: [new MockSource({ name: "A", key: "doaj", byDoi: { "10.1234/example": target } })],
      similar: [one, two],
    });

    const response = await orchestrator.findPaper({ doi: "10.1234/example" });
    const sharedEntries = response.similarPapers.filter((p) => p.doi === "10.1234/shared");
    expect(sharedEntries).toHaveLength(1);
    expect(sharedEntries[0]!.sources).toEqual(expect.arrayContaining(["SimOne", "SimTwo"]));
  });

  it("does not run the similar phase when no main paper was found", async () => {
    const similarity = new MockSource({ name: "Sim", key: "semanticScholar", related: [makePaper()] });
    const { orchestrator } = buildHarness({
      primary: [new MockSource({ name: "A", key: "doaj", results: [] })],
      similar: [similarity],
    });

    const response = await orchestrator.findPaper({ title: "Nothing Matches This Title Anywhere" });
    expect(response.exactPaper).toBeNull();
    expect(similarity.calls).toHaveLength(0);
  });
});

describe("SearchOrchestrator - lookupById", () => {
  it("resolves a DOI through the first source that knows it", async () => {
    const target = makePaper({ source: "A", doi: "10.1234/example" });
    const sourceA = new MockSource({ name: "A", key: "doaj", byDoi: { "10.1234/example": target } });

    const { orchestrator } = buildHarness({
      primary: [sourceA],
      similar: [new MockSource({ name: "Sim", key: "semanticScholar" })],
    });

    const paper = await orchestrator.lookupById("doi", "10.1234/example");
    expect(paper?.doi).toBe("10.1234/example");
  });

  it("returns null when no source recognises the id", async () => {
    const { orchestrator } = buildHarness({
      primary: [new MockSource({ name: "A", key: "doaj" })],
      similar: [new MockSource({ name: "Sim", key: "semanticScholar" })],
    });
    expect(await orchestrator.lookupById("doi", "10.9999/unknown")).toBeNull();
  });
});

describe("helpers", () => {
  it("mergeStatuses collapses repeated rows and prefers success", () => {
    const merged = mergeStatuses([
      { name: "DOAJ", status: "failed", resultCount: 0, durationMs: 10, error: "boom" },
      { name: "DOAJ", status: "success", resultCount: 3, durationMs: 20 },
      { name: "CORE", status: "skipped", resultCount: 0, durationMs: 0, error: "no key" },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ name: "DOAJ", status: "success", resultCount: 3, durationMs: 30 });
    expect(merged[0]!.error).toBeUndefined();
    expect(merged[1]).toMatchObject({ name: "CORE", status: "skipped" });
  });

  it("pickBestFullText prefers an open-access PDF over a landing page", () => {
    const best = pickBestFullText([
      { available: false, url: "https://publisher.example/abs/1", type: "html", accessType: "landing-page" },
      { available: true, url: "https://repo.example/paper.pdf", type: "pdf", accessType: "open-access" },
      { available: false, accessType: "unavailable" },
    ]);
    expect(best.accessType).toBe("open-access");
    expect(best.type).toBe("pdf");
  });

  it("pickBestFullText falls back to the landing page when nothing is open", () => {
    const best = pickBestFullText([
      { available: false, accessType: "unavailable" },
      { available: false, url: "https://doi.org/10.1234/x", type: "html", accessType: "landing-page" },
    ]);
    expect(best.accessType).toBe("landing-page");
    expect(best.url).toBe("https://doi.org/10.1234/x");
  });
});

describe("SearchOrchestrator - extended (last-resort) tier", () => {
  it("queries Europe PMC / DataCite only when the primaries AND fallbacks found nothing", async () => {
    const target = makePaper({ source: "Europe PMC", doi: "10.5281/zenodo.1" });

    const primaryA = new MockSource({ name: "A", key: "doaj", results: [] });
    const crossref = new MockSource({ name: "Crossref", key: "crossref", results: [] });
    const epmc = new MockSource({ name: "Europe PMC", key: "europepmc", results: [target] });

    const { orchestrator } = buildHarness({
      primary: [primaryA],
      fallback: [crossref],
      extended: [epmc],
      similar: [new MockSource({ name: "Sim", key: "semanticScholar", related: [] })],
    });

    const response = await orchestrator.findPaper({
      title: "Deepfake Detection Using Audio and Video",
      authors: ["John Doe"],
    });

    expect(primaryA.searchCallCount).toBeGreaterThan(0);
    expect(crossref.searchCallCount).toBeGreaterThan(0);
    expect(epmc.searchCallCount).toBeGreaterThan(0);
    expect(response.exactPaper?.source).toBe("Europe PMC");
    expect(response.notes?.some((n) => /extended academic sources/i.test(n))).toBe(true);
  });

  it("does NOT touch the extended tier when a primary source already matched", async () => {
    const target = makePaper({ source: "A", doi: "10.1234/example" });
    const primaryA = new MockSource({ name: "A", key: "doaj", results: [target] });
    const crossref = new MockSource({ name: "Crossref", key: "crossref", results: [] });
    const epmc = new MockSource({ name: "Europe PMC", key: "europepmc", results: [] });
    const datacite = new MockSource({ name: "DataCite", key: "datacite", results: [] });

    const { orchestrator } = buildHarness({
      primary: [primaryA],
      fallback: [crossref],
      extended: [epmc, datacite],
      similar: [new MockSource({ name: "Sim", key: "semanticScholar", related: [] })],
    });

    const response = await orchestrator.findPaper({
      title: "Deepfake Detection Using Audio and Video",
      authors: ["John Doe"],
    });

    expect(response.exactPaper?.source).toBe("A");
    expect(crossref.searchCallCount).toBe(0);
    expect(epmc.searchCallCount).toBe(0);
    expect(datacite.searchCallCount).toBe(0);
  });
});
