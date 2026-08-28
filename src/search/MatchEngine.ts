import type { AppConfig } from "../config/env.js";
import type { MatchType, PaperResult } from "../models/Paper.js";
import type { NormalizedQuery } from "../models/Search.js";
import { authorOverlap, normalizeAuthors } from "../utils/normalizeAuthor.js";
import { normalizeDoi } from "../utils/normalizeDoi.js";
import { keywordTokens } from "../utils/normalizeKeywords.js";
import { normalizeTitle } from "../utils/normalizeTitle.js";
import { clamp01, jaccard, roundScore, titleSimilarity } from "../utils/similarity.js";

/**
 * PHASE 4 - exact-match verification.
 *
 * Two independent gates decide "exact", and BOTH the deterministic rules and
 * the numeric score are consulted, so a merely-similar title can never be
 * promoted to an exact match:
 *
 *   Deterministic
 *     - DOIs are equal after normalization                    -> exact
 *     - identical normalized title AND strong author overlap  -> exact
 *     - identical, DISTINCTIVE title with no authors supplied
 *       and nothing contradicting it                          -> exact
 *
 *   Score-based
 *     - weighted final score >= EXACT_MATCH_THRESHOLD, but only when the
 *       title gate is also satisfied
 *
 * A high keyword score alone is never enough to reach "exact" - or even
 * "near-exact": both are claims about identifying one specific paper, and a
 * query with no title and no DOI is discovery, not identification.
 *
 * Scoring uses a weighted mean over APPLICABLE components only. A component
 * the query gave nothing to compare on returns `undefined` and is excluded,
 * with its weight redistributed. Scoring it as 0 instead would mean a
 * title-only query could never exceed ~0.62 no matter how perfectly the title
 * matched, making an exact verdict structurally unreachable.
 */

export interface MatchScore {
  doiScore: number;
  titleScore: number;
  authorScore: number;
  yearScore: number;
  venueScore: number;
  keywordScore: number;
  finalScore: number;
}

export interface MatchVerdict {
  score: MatchScore;
  matchType: MatchType;
  confidence: number;
  isExactMatch: boolean;
  /** Human-readable justification, useful in logs and debugging. */
  reasons: string[];
}

/** Weights used when a DOI was NOT supplied (title-led matching). */
const TITLE_LED_WEIGHTS = {
  title: 0.55,
  author: 0.25,
  year: 0.08,
  venue: 0.05,
  keyword: 0.07,
} as const;

export class MatchEngine {
  private readonly exactThreshold: number;
  private readonly nearExactThreshold: number;
  private readonly titleExactThreshold: number;

  constructor(config: AppConfig) {
    this.exactThreshold = config.matching.exactThreshold;
    this.nearExactThreshold = config.matching.nearExactThreshold;
    this.titleExactThreshold = config.matching.titleExactThreshold;
  }

  /** Scores one candidate against the user's (normalized) query. */
  evaluate(query: NormalizedQuery, candidate: PaperResult): MatchVerdict {
    const reasons: string[] = [];

    // Each component is `undefined` when the query gave us nothing to compare
    // on. `undefined` is NOT the same as 0: a field the user never supplied is
    // missing evidence, not contrary evidence, and must not drag the score
    // down. Its weight is redistributed across the components that do apply.
    const doiScore = this.scoreDoi(query, candidate, reasons);
    const titleScore = this.scoreTitle(query, candidate);
    const authorScore = this.scoreAuthors(query, candidate);
    const yearScore = this.scoreYear(query, candidate);
    const venueScore = this.scoreVenue(query, candidate);
    const keywordScore = this.scoreKeywords(query, candidate);

    // A confirmed DOI match dominates everything else.
    if (doiScore === 1) {
      const score: MatchScore = {
        doiScore,
        titleScore: titleScore ?? 0,
        authorScore: authorScore ?? 0,
        yearScore: yearScore ?? 0,
        venueScore: venueScore ?? 0,
        keywordScore: keywordScore ?? 0,
        finalScore: 1,
      };
      // A DOI match with a wildly different title means the DOI itself is what
      // the user asked for; we trust the identifier but say so.
      if (query.title && (titleScore ?? 0) < 0.5) {
        reasons.push("doi matched but title differs from the supplied title");
      }
      return {
        score: roundAll(score),
        matchType: "exact",
        confidence: 0.99,
        isExactMatch: true,
        reasons,
      };
    }

    // Weighted mean over APPLICABLE components only. Without this
    // redistribution a title-only query could never exceed
    // 0.55 (title) + filler, so a byte-identical title would score ~0.62 and
    // could never be confirmed as exact.
    const applicable: { weight: number; value: number }[] = [];
    if (titleScore !== undefined) applicable.push({ weight: TITLE_LED_WEIGHTS.title, value: titleScore });
    if (authorScore !== undefined) applicable.push({ weight: TITLE_LED_WEIGHTS.author, value: authorScore });
    if (yearScore !== undefined) applicable.push({ weight: TITLE_LED_WEIGHTS.year, value: yearScore });
    if (venueScore !== undefined) applicable.push({ weight: TITLE_LED_WEIGHTS.venue, value: venueScore });
    if (keywordScore !== undefined) applicable.push({ weight: TITLE_LED_WEIGHTS.keyword, value: keywordScore });

    const totalWeight = applicable.reduce((sum, c) => sum + c.weight, 0);
    const finalScore =
      totalWeight > 0
        ? clamp01(applicable.reduce((sum, c) => sum + (c.weight / totalWeight) * c.value, 0))
        : 0;

    const score: MatchScore = {
      doiScore,
      titleScore: titleScore ?? 0,
      authorScore: authorScore ?? 0,
      yearScore: yearScore ?? 0,
      venueScore: venueScore ?? 0,
      keywordScore: keywordScore ?? 0,
      finalScore,
    };

    // Deterministic conditions. The title gate is mandatory for "exact".
    const titleGate = titleScore !== undefined && titleScore >= this.titleExactThreshold;
    const identicalTitle =
      Boolean(query.normalizedTitle) && query.normalizedTitle === normalizeTitle(candidate.title);

    // Authors corroborate the title. The bar is slightly lower when the titles
    // are byte-for-byte identical after normalization, because the title is
    // then already doing most of the identification: a surname-only query
    // ("Vaswani") that matches an author of a title-identical paper is a real
    // match, whereas a CONTRADICTED author (same surname, different initial ->
    // 0.2) still falls below both bars and blocks the promotion.
    const authorGate = identicalTitle ? 0.7 : 0.8;
    const strongAuthors = query.normalizedAuthors.length > 0 && (authorScore ?? 0) >= authorGate;
    // Only a year we could actually compare can contradict; a missing year is
    // silence, not disagreement.
    const noConflictingYear = yearScore === undefined || yearScore !== 0;

    if (identicalTitle) reasons.push("normalized titles are identical");
    if (strongAuthors) reasons.push("author lists overlap strongly");
    if (titleGate && !identicalTitle) reasons.push("titles are near-identical");

    let matchType: MatchType;
    let isExactMatch = false;
    let confidence: number;

    if (titleGate && strongAuthors && noConflictingYear) {
      matchType = "exact";
      isExactMatch = true;
      confidence = Math.max(this.exactThreshold, Math.min(0.98, 0.9 + 0.08 * finalScore));
    } else if (
      identicalTitle &&
      query.normalizedAuthors.length === 0 &&
      noConflictingYear &&
      isDistinctiveTitle(query.normalizedTitle) &&
      finalScore >= this.exactThreshold
    ) {
      // Title-only query. An identical, distinctive title identifies the paper
      // on its own - but a short generic title ("Editorial", "Introduction")
      // is shared by thousands of papers, so `isDistinctiveTitle` blocks it.
      matchType = "exact";
      isExactMatch = true;
      confidence = Math.max(this.exactThreshold, finalScore);
      reasons.push("distinctive identical title with no conflicting metadata");
    } else if (query.title !== undefined && finalScore >= this.nearExactThreshold) {
      // "near-exact" is a claim about identifying a specific paper, so it
      // requires a title. A keyword/author-only query is discovery, not
      // identification, however well its terms happen to overlap.
      matchType = "near-exact";
      confidence = finalScore;
    } else if ((titleScore ?? 0) >= 0.5 || (keywordScore ?? 0) >= 0.5) {
      matchType = "similar";
      confidence = finalScore;
    } else {
      matchType = "keyword";
      confidence = finalScore;
    }

    return {
      score: roundAll(score),
      matchType,
      confidence: roundScore(confidence),
      isExactMatch,
      reasons,
    };
  }

  /**
   * Picks the best candidate from a source's results and annotates it.
   * Returns `undefined` when nothing is even loosely relevant.
   */
  selectBest(query: NormalizedQuery, candidates: readonly PaperResult[]): { paper: PaperResult; verdict: MatchVerdict } | undefined {
    let best: { paper: PaperResult; verdict: MatchVerdict } | undefined;

    for (const candidate of candidates) {
      const verdict = this.evaluate(query, candidate);
      if (!best || verdict.score.finalScore > best.verdict.score.finalScore) {
        best = { paper: candidate, verdict };
      }
      // Nothing can beat a confirmed DOI match, so stop looking.
      if (verdict.isExactMatch && verdict.score.doiScore === 1) break;
    }

    if (!best || best.verdict.score.finalScore <= 0) return undefined;
    return best;
  }

  /** Applies a verdict to a paper, producing the annotated result. */
  annotate(paper: PaperResult, verdict: MatchVerdict): PaperResult {
    return {
      ...paper,
      matchType: verdict.matchType,
      confidence: verdict.confidence,
    };
  }

  /* ------------------------------------------------------------------ */

  private scoreDoi(query: NormalizedQuery, candidate: PaperResult, reasons: string[]): number {
    if (!query.doi) return 0;
    const candidateDoi = normalizeDoi(candidate.doi);
    if (!candidateDoi) return 0;
    if (candidateDoi === query.doi) {
      reasons.push("DOI matches exactly");
      return 1;
    }
    return 0;
  }

  /** `undefined` when the user supplied no title to compare against. */
  private scoreTitle(query: NormalizedQuery, candidate: PaperResult): number | undefined {
    if (!query.title) return undefined;
    return titleSimilarity(query.title, candidate.title);
  }

  /** `undefined` when either side has no author list. */
  private scoreAuthors(query: NormalizedQuery, candidate: PaperResult): number | undefined {
    if (query.normalizedAuthors.length === 0) return undefined;
    const candidateAuthors = normalizeAuthors(candidate.authors);
    if (candidateAuthors.length === 0) return undefined;
    return authorOverlap(query.normalizedAuthors, candidateAuthors);
  }

  /**
   * Year is only meaningful if the user gave one. This API does not ask for a
   * year directly, so it is inferred from a 4-digit year embedded in the title
   * (common when a citation is pasted). With no hint, or no year on the
   * candidate, there is nothing to compare and the component is excluded.
   */
  private scoreYear(query: NormalizedQuery, candidate: PaperResult): number | undefined {
    const queryYear = extractYearHint(query.raw.title);
    if (queryYear === undefined || candidate.year === undefined) return undefined;
    const diff = Math.abs(candidate.year - queryYear);
    if (diff === 0) return 1;
    // Preprint-then-journal publication commonly shifts the year by one.
    if (diff === 1) return 0.7;
    return 0;
  }

  /**
   * Venue only carries signal when the user pasted a citation that names it
   * ("Title. NeurIPS 2017"). It is POSITIVE evidence only: when the venue is
   * not mentioned in the query the component is excluded rather than scored
   * neutral, which would otherwise cap a perfect title match below 1.
   */
  private scoreVenue(query: NormalizedQuery, candidate: PaperResult): number | undefined {
    const venue = candidate.journal ?? candidate.conference;
    if (!venue || !query.title) return undefined;
    const normalizedVenue = normalizeTitle(venue);
    const normalizedTitleText = query.normalizedTitle ?? "";
    if (!normalizedVenue || !normalizedTitleText) return undefined;
    return normalizedTitleText.includes(normalizedVenue) ? 1 : undefined;
  }

  /** `undefined` when the user supplied no keywords to compare against. */
  private scoreKeywords(query: NormalizedQuery, candidate: PaperResult): number | undefined {
    if (query.keywords.length === 0) return undefined;
    const queryTokens = keywordTokens(query.keywords);
    const candidateTokens = keywordTokens([
      ...(candidate.keywords ?? []),
      ...(candidate.topics ?? []),
      normalizeTitle(candidate.title, { removeStopWords: true }),
    ]);
    if (queryTokens.size === 0 || candidateTokens.size === 0) return undefined;
    return jaccard(queryTokens, candidateTokens);
  }
}

/**
 * Guards the title-only exact path. A title identifies a paper only when it is
 * long and specific enough to be effectively unique; "Editorial", "Preface" or
 * "Annual Report" are shared by thousands of records.
 */
export function isDistinctiveTitle(normalizedTitle: string | undefined): boolean {
  if (!normalizedTitle) return false;
  const words = normalizedTitle.split(" ").filter(Boolean);
  return normalizedTitle.length >= 15 && words.length >= 3;
}

/** Pulls a "(2023)" / " 2023" style year hint out of a pasted citation. */
export function extractYearHint(title: string | undefined): number | undefined {
  if (!title) return undefined;
  const match = /\((19|20)\d{2}\)/.exec(title) ?? /\b(19|20)\d{2}\b/.exec(title);
  if (!match) return undefined;
  const year = Number(match[0].replace(/[()]/g, ""));
  const currentYear = new Date().getFullYear();
  return year >= 1900 && year <= currentYear + 1 ? year : undefined;
}

function roundAll(score: MatchScore): MatchScore {
  return {
    doiScore: roundScore(score.doiScore),
    titleScore: roundScore(score.titleScore),
    authorScore: roundScore(score.authorScore),
    yearScore: roundScore(score.yearScore),
    venueScore: roundScore(score.venueScore),
    keywordScore: roundScore(score.keywordScore),
    finalScore: roundScore(score.finalScore),
  };
}
