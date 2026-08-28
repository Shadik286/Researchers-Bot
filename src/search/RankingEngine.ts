import type { AppConfig } from "../config/env.js";
import type { PaperResult } from "../models/Paper.js";
import { keywordTokens } from "../utils/normalizeKeywords.js";
import { normalizeTitle, titleFingerprint } from "../utils/normalizeTitle.js";
import { clamp01, cosineSimilarity, jaccard, roundScore, titleSimilarity } from "../utils/similarity.js";

/**
 * PHASE 10 - similarity scoring and ranking.
 *
 * Similarity model (weights configurable via SIM_WEIGHT_*):
 *
 *   title    40%   normalized title similarity
 *   abstract 30%   bag-of-words cosine over abstracts
 *   keywords 20%   Jaccard over keyword/subject tokens
 *   topics   10%   Jaccard over topic/concept labels
 *
 * A component with no data on either side is EXCLUDED and its weight is
 * redistributed across the components that do have data, so a paper is not
 * punished merely because one source omitted an abstract.
 *
 * A small, capped bonus rewards a shared citation relationship and a shared
 * venue, which is what separates "genuinely related" from "shares one keyword".
 */

export interface SimilarityBreakdown {
  title: number;
  abstract: number;
  keywords: number;
  topics: number;
  relationBonus: number;
  final: number;
}

export interface RankedPaper {
  paper: PaperResult;
  breakdown: SimilarityBreakdown;
}

const MAX_RELATION_BONUS = 0.1;

/**
 * Recency preference. Scholarly relevance still dominates - this is a small
 * tie-breaking nudge so that, between two comparably relevant papers, the more
 * recent one surfaces first. Set RECENCY_BOOST=0 to rank purely by relevance.
 */
const RECENCY_WINDOW_YEARS = 12;

export function recencyBonus(year: number | undefined, maxBonus: number): number {
  if (maxBonus <= 0 || year === undefined) return 0;
  const currentYear = new Date().getFullYear();
  const age = currentYear - year;
  if (age <= 0) return maxBonus;
  if (age >= RECENCY_WINDOW_YEARS) return 0;
  return maxBonus * (1 - age / RECENCY_WINDOW_YEARS);
}

/**
 * Drops papers outside an explicit year range.
 *
 * A paper whose year is unknown is excluded when a range is given: we cannot
 * verify it, and inventing a year to keep it would be fabricating metadata.
 */
export function withinYearRange(
  year: number | undefined,
  fromYear: number | undefined,
  toYear: number | undefined,
): boolean {
  if (fromYear === undefined && toYear === undefined) return true;
  if (year === undefined) return false;
  if (fromYear !== undefined && year < fromYear) return false;
  if (toYear !== undefined && year > toYear) return false;
  return true;
}

export class RankingEngine {
  private readonly weights: AppConfig["similarityWeights"];
  private readonly recencyBoost: number;

  constructor(config: AppConfig) {
    this.weights = config.similarityWeights;
    this.recencyBoost = config.recencyBoost;
  }

  /** Similarity of `candidate` to the main paper, in 0..1. */
  score(main: PaperResult, candidate: PaperResult): SimilarityBreakdown {
    const components: { weight: number; value: number }[] = [];

    const titleValue = titleSimilarity(main.title, candidate.title);
    components.push({ weight: this.weights.title, value: titleValue });

    let abstractValue = 0;
    if (main.abstract && candidate.abstract) {
      abstractValue = cosineSimilarity(main.abstract, candidate.abstract);
      components.push({ weight: this.weights.abstract, value: abstractValue });
    }

    let keywordValue = 0;
    const mainKeywords = keywordTokens(main.keywords);
    const candidateKeywords = keywordTokens(candidate.keywords);
    if (mainKeywords.size > 0 && candidateKeywords.size > 0) {
      keywordValue = jaccard(mainKeywords, candidateKeywords);
      components.push({ weight: this.weights.keywords, value: keywordValue });
    }

    let topicValue = 0;
    const mainTopics = normalizedSet(main.topics);
    const candidateTopics = normalizedSet(candidate.topics);
    if (mainTopics.size > 0 && candidateTopics.size > 0) {
      topicValue = jaccard(mainTopics, candidateTopics);
      components.push({ weight: this.weights.topics, value: topicValue });
    }

    const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
    const weighted =
      totalWeight > 0
        ? components.reduce((sum, c) => sum + (c.weight / totalWeight) * c.value, 0)
        : 0;

    const relationBonus = this.relationBonus(main, candidate);
    const final = clamp01(weighted + relationBonus + recencyBonus(candidate.year, this.recencyBoost));

    return {
      title: roundScore(titleValue),
      abstract: roundScore(abstractValue),
      keywords: roundScore(keywordValue),
      topics: roundScore(topicValue),
      relationBonus: roundScore(relationBonus),
      final: roundScore(final),
    };
  }

  /**
   * Ranks candidates against the main paper and returns the top `limit`,
   * excluding the main paper itself.
   */
  rankSimilar(
    main: PaperResult,
    candidates: readonly PaperResult[],
    limit: number,
    yearRange?: { fromYear?: number; toYear?: number },
  ): PaperResult[] {
    const ranked: RankedPaper[] = [];

    for (const candidate of candidates) {
      if (isSamePaper(main, candidate)) continue;
      if (!withinYearRange(candidate.year, yearRange?.fromYear, yearRange?.toYear)) continue;
      const breakdown = this.score(main, candidate);
      ranked.push({ paper: candidate, breakdown });
    }

    ranked.sort((a, b) => {
      if (b.breakdown.final !== a.breakdown.final) return b.breakdown.final - a.breakdown.final;
      // Tie-breakers: an accessible full text, then citation count, then recency.
      const aAccess = a.paper.pdfUrl ? 1 : 0;
      const bAccess = b.paper.pdfUrl ? 1 : 0;
      if (aAccess !== bAccess) return bAccess - aAccess;
      const aCites = a.paper.citationCount ?? 0;
      const bCites = b.paper.citationCount ?? 0;
      if (aCites !== bCites) return bCites - aCites;
      return (b.paper.year ?? 0) - (a.paper.year ?? 0);
    });

    // The deduplicator deliberately refuses to merge records with DIFFERENT
    // DOIs - a preprint and its published version are distinct works. For the
    // similar list that is still a bad result: the reader sees the same title
    // twice. So the OUTPUT is filtered to visibly distinct titles, keeping the
    // higher-scoring member of each pair.
    const selected = filterDistinctTitles(ranked, (entry) => entry.paper.title, limit);

    return selected.map(({ paper, breakdown }) => ({
      ...paper,
      matchType: "similar" as const,
      similarityScore: breakdown.final,
      confidence: breakdown.final,
    }));
  }

  /**
   * Orders main-paper candidates by match confidence. Used when no exact match
   * was found and the response falls back to the best available candidates.
   */
  rankCandidates(candidates: readonly PaperResult[]): PaperResult[] {
    return [...candidates].sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      const aSources = a.sources?.length ?? 1;
      const bSources = b.sources?.length ?? 1;
      if (aSources !== bSources) return bSources - aSources;
      return (b.citationCount ?? 0) - (a.citationCount ?? 0);
    });
  }

  /** Small capped bonus for a real bibliographic relationship. */
  private relationBonus(main: PaperResult, candidate: PaperResult): number {
    let bonus = 0;

    const mainRefs = new Set(main.referenceIds ?? []);
    const candidateRefs = new Set(candidate.referenceIds ?? []);

    // Candidate is cited by the main paper (or vice versa).
    if (candidate.doi && mainRefs.has(candidate.doi)) bonus += 0.06;
    if (main.doi && candidateRefs.has(main.doi)) bonus += 0.06;

    // Bibliographic coupling: they cite the same works.
    if (mainRefs.size >= 3 && candidateRefs.size >= 3) {
      let shared = 0;
      for (const ref of candidateRefs) if (mainRefs.has(ref)) shared += 1;
      if (shared >= 3) bonus += 0.04;
    }

    const mainVenue = normalizeTitle(main.journal ?? main.conference ?? "");
    const candidateVenue = normalizeTitle(candidate.journal ?? candidate.conference ?? "");
    if (mainVenue && mainVenue === candidateVenue) bonus += 0.02;

    return Math.min(bonus, MAX_RELATION_BONUS);
  }
}

/** Identity check used to keep the main paper out of its own similar list. */
export function isSamePaper(a: PaperResult, b: PaperResult): boolean {
  if (a.doi && b.doi) return a.doi === b.doi;
  if (a.pmcid && b.pmcid && a.pmcid.toUpperCase() === b.pmcid.toUpperCase()) return true;
  if (a.pmid && b.pmid && a.pmid === b.pmid) return true;
  if (a.arxivId && b.arxivId && stripVersion(a.arxivId) === stripVersion(b.arxivId)) return true;
  if (a.source === b.source && a.sourceId && b.sourceId && a.sourceId === b.sourceId) return true;
  return normalizeTitle(a.title, { removeStopWords: true }) === normalizeTitle(b.title, { removeStopWords: true });
}

function stripVersion(id: string): string {
  return id.replace(/v\d+$/i, "").toLowerCase();
}

function normalizedSet(values: readonly string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const value of values ?? []) {
    const normalized = normalizeTitle(value, { removeStopWords: true });
    if (normalized) out.add(normalized);
  }
  return out;
}

/**
 * Keeps only visibly distinct titles, in order, up to `limit`.
 *
 * The deduplicator deliberately refuses to merge records with DIFFERENT DOIs -
 * a preprint and its published version are distinct works. For a result LIST
 * that is still a bad outcome: the reader sees the same title twice. Shared by
 * the similar-paper and discovery result paths.
 */
export function filterDistinctTitles<T>(
  entries: readonly T[],
  titleOf: (entry: T) => string,
  limit: number,
): T[] {
  const selected: T[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (selected.length >= limit) break;
    const fingerprint = titleFingerprint(titleOf(entry));
    if (fingerprint && seen.has(fingerprint)) continue;
    if (fingerprint) seen.add(fingerprint);
    selected.push(entry);
  }
  return selected;
}
