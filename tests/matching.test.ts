import { describe, expect, it } from "vitest";

import { buildConfig } from "../src/config/env.js";
import type { PaperResult } from "../src/models/Paper.js";
import { Deduplicator, identityKeys, mergePapers } from "../src/search/Deduplicator.js";
import { MatchEngine, extractYearHint } from "../src/search/MatchEngine.js";
import { normalizeQuery } from "../src/search/QueryBuilder.js";
import { RankingEngine, isSamePaper } from "../src/search/RankingEngine.js";
import { cosineSimilarity, diceCoefficient, jaccard, levenshtein, levenshteinSimilarity, titleSimilarity } from "../src/utils/similarity.js";

const config = buildConfig({ NODE_ENV: "test" });
const matchEngine = new MatchEngine(config);
const ranking = new RankingEngine(config);

function paper(overrides: Partial<PaperResult> = {}): PaperResult {
  return {
    title: "Deepfake Detection Using Audio and Video",
    authors: ["John Doe", "Jane Roe"],
    source: "Semantic Scholar",
    matchType: "keyword",
    confidence: 0,
    ...overrides,
  };
}

describe("similarity primitives", () => {
  it("computes edit distance", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("same", "same")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshteinSimilarity("abc", "abc")).toBe(1);
    expect(levenshteinSimilarity("abc", "xyz")).toBe(0);
  });

  it("computes set overlap", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
    expect(jaccard(new Set(), new Set(["b"]))).toBe(0);
    expect(diceCoefficient("night", "nacht")).toBeGreaterThan(0);
  });

  it("scores identical titles as 1 and unrelated ones near 0", () => {
    expect(titleSimilarity("Deepfake Detection", "deepfake  detection")).toBe(1);
    expect(titleSimilarity("Deepfake Detection", "A Study of Coral Reefs")).toBeLessThan(0.2);
    expect(titleSimilarity(undefined, "x")).toBe(0);
  });

  it("tolerates a dropped subtitle", () => {
    const score = titleSimilarity(
      "Deepfake Detection Using Audio and Video",
      "Deepfake Detection Using Audio and Video: A Multimodal Approach",
    );
    expect(score).toBeGreaterThan(0.85);
  });

  it("compares abstracts by cosine similarity", () => {
    const a = "We propose a multimodal neural network for detecting manipulated audio and video recordings.";
    const b = "This paper proposes a multimodal neural approach for detecting manipulated audio and video.";
    const c = "We study the migration patterns of arctic terns across the northern hemisphere.";
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.5);
    expect(cosineSimilarity(a, c)).toBeLessThan(0.15);
  });
});

describe("MatchEngine", () => {
  it("marks an exact DOI match as exact with very high confidence", () => {
    const query = normalizeQuery({ doi: "10.1234/example" });
    const verdict = matchEngine.evaluate(query, paper({ doi: "10.1234/example" }));
    expect(verdict.isExactMatch).toBe(true);
    expect(verdict.matchType).toBe("exact");
    expect(verdict.confidence).toBeGreaterThanOrEqual(0.95);
    expect(verdict.score.doiScore).toBe(1);
  });

  it("treats DOI equality as case-insensitive and resolver-agnostic", () => {
    const query = normalizeQuery({ doi: "https://doi.org/10.1234/EXAMPLE" });
    expect(matchEngine.evaluate(query, paper({ doi: "doi:10.1234/example" })).isExactMatch).toBe(true);
  });

  it("does not treat a different DOI as a match", () => {
    const query = normalizeQuery({ doi: "10.1234/example" });
    const verdict = matchEngine.evaluate(query, paper({ doi: "10.9999/other" }));
    expect(verdict.isExactMatch).toBe(false);
    expect(verdict.score.doiScore).toBe(0);
  });

  it("marks an identical title with strong author overlap as exact", () => {
    const query = normalizeQuery({
      title: "Deepfake Detection Using Audio and Video",
      authors: ["John Doe"],
    });
    const verdict = matchEngine.evaluate(query, paper());
    expect(verdict.isExactMatch).toBe(true);
    expect(verdict.score.titleScore).toBe(1);
    expect(verdict.score.authorScore).toBeGreaterThanOrEqual(0.8);
  });

  it("marks an identical title with a surname-only author as exact", () => {
    // The user typed everything they knew. An identical title plus a matching
    // surname is a real identification, not a near miss.
    const query = normalizeQuery({ title: "Attention Is All You Need", authors: ["Vaswani"] });
    const candidate = paper({
      title: "Attention Is All You Need",
      authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"],
    });
    const verdict = matchEngine.evaluate(query, candidate);
    expect(verdict.isExactMatch).toBe(true);
    expect(verdict.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it("still refuses an identical title when the given name contradicts", () => {
    const query = normalizeQuery({ title: "Attention Is All You Need", authors: ["Bob Vaswani"] });
    const candidate = paper({ title: "Attention Is All You Need", authors: ["Ashish Vaswani"] });
    expect(matchEngine.evaluate(query, candidate).isExactMatch).toBe(false);
  });

  it("does NOT mark a merely similar title as exact", () => {
    const query = normalizeQuery({ title: "Deepfake Detection Using Audio and Video", authors: ["John Doe"] });
    const verdict = matchEngine.evaluate(query, paper({ title: "Deepfake Detection Using Only Video Signals" }));
    expect(verdict.isExactMatch).toBe(false);
    expect(verdict.matchType).not.toBe("exact");
  });

  it("does NOT mark an identical title with a conflicting author list as exact", () => {
    const query = normalizeQuery({
      title: "Deepfake Detection Using Audio and Video",
      authors: ["Someone Entirely Different"],
    });
    const verdict = matchEngine.evaluate(query, paper());
    expect(verdict.isExactMatch).toBe(false);
  });

  it("never promotes a keyword-only hit to exact", () => {
    const query = normalizeQuery({ keywords: ["deepfake", "audio", "video"] });
    const verdict = matchEngine.evaluate(query, paper());
    expect(verdict.isExactMatch).toBe(false);
    expect(["keyword", "similar", "near-exact"]).toContain(verdict.matchType);
  });

  it("selects the best candidate from a source's results", () => {
    const query = normalizeQuery({ title: "Deepfake Detection Using Audio and Video", authors: ["John Doe"] });
    const best = matchEngine.selectBest(query, [
      paper({ title: "Something Unrelated About Coral Reefs", authors: ["Ann Poe"] }),
      paper(),
      paper({ title: "Deepfake Detection Using Video" }),
    ]);
    expect(best?.paper.title).toBe("Deepfake Detection Using Audio and Video");
    expect(best?.verdict.isExactMatch).toBe(true);
  });

  it("returns undefined when nothing is relevant", () => {
    const query = normalizeQuery({ title: "Deepfake Detection" });
    expect(matchEngine.selectBest(query, [])).toBeUndefined();
  });

  it("extracts a year hint from a pasted citation title", () => {
    expect(extractYearHint("Deepfake Detection (2023)")).toBe(2023);
    expect(extractYearHint("Deepfake Detection")).toBeUndefined();
    expect(extractYearHint("Paper from 1750")).toBeUndefined();
  });
});

describe("Deduplicator", () => {
  const dedup = new Deduplicator();

  it("collapses records sharing a DOI across six sources", () => {
    const sources = ["DOAJ", "CORE", "Semantic Scholar", "Crossref", "OpenAlex", "arXiv"];
    const input = sources.map((source) =>
      paper({ source, sources: [source], doi: "10.1234/example", sourceId: `${source}-1` }),
    );

    const { papers, mergedCount } = dedup.deduplicate(input);
    expect(papers).toHaveLength(1);
    expect(mergedCount).toBe(5);
    expect(papers[0]!.sources).toEqual(sources);
  });

  it("collapses on PMID / PMCID / arXiv id", () => {
    expect(dedup.deduplicate([paper({ pmid: "123" }), paper({ pmid: "123", title: "Other title entirely" })]).papers).toHaveLength(1);
    expect(dedup.deduplicate([paper({ pmcid: "PMC1" }), paper({ pmcid: "pmc1", title: "Other" })]).papers).toHaveLength(1);
    expect(
      dedup.deduplicate([paper({ arxivId: "2101.00001" }), paper({ arxivId: "2101.00001v2", title: "Other" })]).papers,
    ).toHaveLength(1);
  });

  it("collapses on normalized title + author overlap when no ids exist", () => {
    const { papers } = dedup.deduplicate([
      paper({ source: "DOAJ", title: "Deepfake Detection Using Audio and Video" }),
      paper({ source: "CORE", title: "Deep-fake detection using audio and video" }),
    ]);
    expect(papers).toHaveLength(1);
    expect(papers[0]!.sources).toEqual(["DOAJ", "CORE"]);
  });

  it("never merges two records with DIFFERENT DOIs", () => {
    const { papers } = dedup.deduplicate([
      paper({ doi: "10.1234/a" }),
      paper({ doi: "10.1234/b" }),
    ]);
    expect(papers).toHaveLength(2);
  });

  it("does not merge same-title papers from different years", () => {
    const { papers } = dedup.deduplicate([
      paper({ title: "Annual Review of Methods", year: 2010, authors: ["A One"] }),
      paper({ title: "Annual Review of Methods", year: 2020, authors: ["B Two"] }),
    ]);
    expect(papers).toHaveLength(2);
  });

  it("merges metadata, preferring the richer value", () => {
    const merged = mergePapers(
      paper({ source: "DOAJ", abstract: "Short.", authors: ["John Doe"], year: undefined }),
      paper({
        source: "Crossref",
        abstract: "A considerably longer and more complete abstract describing the study.",
        authors: ["John Doe", "Jane Roe", "Sam Poe"],
        year: 2024,
        publisher: "IEEE",
      }),
    );
    expect(merged.abstract).toContain("considerably longer");
    expect(merged.authors).toHaveLength(3);
    expect(merged.year).toBe(2024);
    expect(merged.publisher).toBe("IEEE");
    expect(merged.sources).toEqual(["DOAJ", "Crossref"]);
  });

  it("preserves every source link after merging", () => {
    const { papers } = dedup.deduplicate([
      paper({
        source: "DOAJ",
        doi: "10.1234/x",
        landingPageUrl: "https://doaj.org/article/1",
        sourceLinks: [{ source: "DOAJ", landingPageUrl: "https://doaj.org/article/1" }],
      }),
      paper({
        source: "CORE",
        doi: "10.1234/x",
        pdfUrl: "https://repo.example.org/paper.pdf",
        sourceLinks: [{ source: "CORE", pdfUrl: "https://repo.example.org/paper.pdf" }],
      }),
    ]);
    expect(papers[0]!.sourceLinks).toHaveLength(2);
    expect(papers[0]!.pdfUrl).toBe("https://repo.example.org/paper.pdf");
    expect(papers[0]!.landingPageUrl).toBe("https://doaj.org/article/1");
  });

  it("lists identity keys strongest-first", () => {
    expect(identityKeys(paper({ doi: "10.1234/x", pmid: "9", arxivId: "2101.00001" }))[0]).toBe("doi:10.1234/x");
  });
});

describe("RankingEngine", () => {
  const main = paper({
    title: "Deepfake Detection Using Audio and Video",
    abstract: "We propose a multimodal neural network combining audio and video signals to detect deepfakes.",
    keywords: ["deepfake", "audio", "video", "multimodal"],
    topics: ["Computer Vision"],
    doi: "10.1234/main",
  });

  it("ranks a genuinely related paper above one sharing a single keyword", () => {
    const related = paper({
      title: "Multimodal Deepfake Detection with Audio-Visual Fusion",
      abstract: "A multimodal neural network fusing audio and video signals to detect deepfake recordings.",
      keywords: ["deepfake", "audio", "video", "fusion"],
      topics: ["Computer Vision"],
      doi: "10.1234/related",
    });
    const tangential = paper({
      title: "Audio Compression Standards for Broadcast Radio",
      abstract: "A survey of lossy audio compression codecs used in terrestrial radio broadcasting.",
      keywords: ["audio"],
      topics: ["Signal Processing"],
      doi: "10.1234/tangential",
    });

    const ranked = ranking.rankSimilar(main, [tangential, related], 10);
    expect(ranked[0]!.doi).toBe("10.1234/related");
    expect(ranked[0]!.similarityScore!).toBeGreaterThan(ranked[1]!.similarityScore!);
    expect(ranked[0]!.matchType).toBe("similar");
  });

  it("excludes the main paper from its own similar list", () => {
    const ranked = ranking.rankSimilar(main, [main, paper({ doi: "10.1234/other", title: "Other Study" })], 10);
    expect(ranked.every((p) => p.doi !== "10.1234/main")).toBe(true);
  });

  it("never returns the same title twice, even across different DOIs", () => {
    // A preprint and its published version are genuinely different works, so
    // the deduplicator keeps them apart - but the reader must not see the same
    // title listed twice.
    const preprint = paper({
      doi: "10.48550/arxiv.2201.00001",
      title: "A Systematic Review of the Use of Blockchain in Healthcare",
      year: 2022,
    });
    const published = paper({
      doi: "10.1234/journal.version",
      title: "A Systematic Review of the Use of Blockchain in Healthcare",
      year: 2022,
    });
    const other = paper({ doi: "10.1234/other", title: "Blockchain Application in Healthcare Systems" });

    const ranked = ranking.rankSimilar(main, [preprint, published, other], 10);
    const titles = ranked.map((p) => p.title);
    expect(new Set(titles).size).toBe(titles.length);
    expect(ranked).toHaveLength(2);
  });

  it("caps the list at the requested size", () => {
    const candidates = Array.from({ length: 30 }, (_, i) =>
      paper({ doi: `10.1234/c${i}`, title: `Deepfake Detection Variant ${i}` }),
    );
    expect(ranking.rankSimilar(main, candidates, 10)).toHaveLength(10);
  });

  it("redistributes weight when a component has no data on either side", () => {
    const noAbstract = paper({ title: "Deepfake Detection Using Audio and Video", doi: "10.1234/no-abs" });
    const score = ranking.score(main, noAbstract);
    // Title matches exactly, so the score must stay high despite the missing
    // abstract rather than being dragged toward zero.
    expect(score.final).toBeGreaterThan(0.8);
    expect(score.abstract).toBe(0);
  });

  it("rewards a real citation relationship, but only a little", () => {
    const cited = paper({ doi: "10.1234/cited", title: "Completely Different Topic In Marine Biology" });
    const withRef = { ...main, referenceIds: ["10.1234/cited"] };
    const withoutRef = { ...main, referenceIds: [] };
    const boosted = ranking.score(withRef, cited).final;
    const plain = ranking.score(withoutRef, cited).final;
    expect(boosted).toBeGreaterThan(plain);
    expect(boosted - plain).toBeLessThanOrEqual(0.1);
  });

  it("identifies the same paper across id types", () => {
    expect(isSamePaper(paper({ doi: "10.1/a" }), paper({ doi: "10.1/a" }))).toBe(true);
    expect(isSamePaper(paper({ doi: "10.1/a" }), paper({ doi: "10.1/b" }))).toBe(false);
    expect(isSamePaper(paper({ arxivId: "2101.00001" }), paper({ arxivId: "2101.00001v3" }))).toBe(true);
  });

  it("orders main-paper candidates by confidence", () => {
    const ordered = ranking.rankCandidates([
      paper({ title: "Low", confidence: 0.3 }),
      paper({ title: "High", confidence: 0.9 }),
    ]);
    expect(ordered[0]!.title).toBe("High");
  });
});
