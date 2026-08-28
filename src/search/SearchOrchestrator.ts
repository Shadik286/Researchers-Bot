import type { AppConfig } from "../config/env.js";
import type { SourceRegistry } from "../config/sources.js";
import { HttpError } from "../http/HttpError.js";
import type { Logger } from "../logging/Logger.js";
import type { FullTextResult } from "../models/FullText.js";
import { UNAVAILABLE_FULL_TEXT } from "../models/FullText.js";
import type { PaperResult } from "../models/Paper.js";
import type { NormalizedQuery, PaperSearchQuery, SearchResponse } from "../models/Search.js";
import type { AcademicSource, SourceStatus } from "../models/Source.js";
import { deriveFullText } from "../sources/BaseSource.js";
import { Deduplicator } from "./Deduplicator.js";
import { MatchEngine, type MatchVerdict } from "./MatchEngine.js";
import { buildQueryVariants, normalizeQuery, type QueryVariant } from "./QueryBuilder.js";
import { RankingEngine, filterDistinctTitles, recencyBonus, withinYearRange } from "./RankingEngine.js";
import { SimilarPaperEngine, classifyFailure } from "./SimilarPaperEngine.js";

/**
 * The search orchestrator - PHASES 1 to 11.
 *
 *   1  normalize the input
 *   2  strong-identifier (DOI) search
 *   3  primary directory search (DOAJ, PMC, CORE, arXiv, Semantic Scholar)
 *   4  exact-match verification
 *   5  IMMEDIATE cancellation of remaining MAIN-PAPER work
 *   6  fallback search (Crossref, OpenAlex) only if still unresolved
 *   7  main-paper normalization + legal full-text resolution
 *   8  similar-paper discovery (separate stage, separate cancellation scope)
 *   9  deduplication
 *  10  ranking
 *  11  final response
 *
 * The critical distinction: `mainController` governs main-paper discovery only.
 * Aborting it stops queued source calls instantly (the rate limiter and the
 * HTTP client both honour the signal) while the similar-paper stage runs under
 * its own, untouched controller.
 */

export interface OrchestratorOptions {
  registry: SourceRegistry;
  config: AppConfig;
  logger: Logger;
}

interface MainSearchOutcome {
  paper: PaperResult | null;
  verdict: MatchVerdict | null;
  statuses: SourceStatus[];
  stoppedEarly: boolean;
  notes: string[];
  candidates: PaperResult[];
}

export class SearchOrchestrator {
  private readonly registry: SourceRegistry;
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly matchEngine: MatchEngine;
  private readonly ranking: RankingEngine;
  private readonly deduplicator = new Deduplicator();
  private readonly similarEngine: SimilarPaperEngine;

  constructor(options: OrchestratorOptions) {
    this.registry = options.registry;
    this.config = options.config;
    this.logger = options.logger.child({ component: "SearchOrchestrator" });
    this.matchEngine = new MatchEngine(options.config);
    this.ranking = new RankingEngine(options.config);
    this.similarEngine = new SimilarPaperEngine(options.registry, this.ranking, options.config, this.logger);
  }

  async findPaper(rawQuery: PaperSearchQuery, requestSignal?: AbortSignal): Promise<SearchResponse> {
    const startedAt = Date.now();

    // ---- PHASE 1: normalization ------------------------------------------
    const query = normalizeQuery(rawQuery);
    this.logger.info("search_started", {
      strategy: query.strategy,
      hasDoi: Boolean(query.doi),
      hasTitle: Boolean(query.title),
      authorCount: query.authors.length,
      keywordCount: query.keywords.length,
    });

    // ---- PHASES 2-6: main-paper discovery --------------------------------
    const mainStartedAt = Date.now();
    const main = await this.findMainPaper(query, requestSignal);
    const mainPaperMs = Date.now() - mainStartedAt;

    // ---- PHASE 7: normalize the main paper + resolve legal full text ------
    let exactPaper: PaperResult | null = null;
    let fullText: FullTextResult | null = null;

    if (main.paper && main.verdict) {
      exactPaper = this.matchEngine.annotate(main.paper, main.verdict);
      fullText = await this.resolveFullText(exactPaper, requestSignal);
      if (fullText?.url && !exactPaper.pdfUrl && fullText.type === "pdf") {
        exactPaper = { ...exactPaper, pdfUrl: fullText.url };
      }
      if (fullText?.accessType === "open-access" && exactPaper.isOpenAccess === undefined) {
        exactPaper = { ...exactPaper, isOpenAccess: true };
      }
    }

    // ---- PHASE 8-10: similar papers (SEPARATE cancellation scope) ---------
    const similarStartedAt = Date.now();
    let similarPapers: PaperResult[] = [];
    let similarStatuses: SourceStatus[] = [];

    if (exactPaper) {
      // NOTE: the main-paper AbortController is deliberately NOT passed here.
      // Only a caller-level cancellation (client disconnect) reaches this stage.
      const outcome = await this.similarEngine.findSimilar(exactPaper, requestSignal, {
        fromYear: query.fromYear,
        toYear: query.toYear,
      });
      similarPapers = outcome.papers;
      similarStatuses = outcome.sourceStatuses;
    } else if (isDiscoveryQuery(query) && main.candidates.length > 0) {
      // Discovery query (CASE C): keywords and/or authors, no title or DOI.
      // There is no single paper to identify, but the sources DID return
      // relevant work - returning nothing would throw away the whole result
      // set. Rank those candidates by relevance to the query instead.
      //
      // A query that DID name a title is an identification attempt: if it
      // failed, the honest answer is "not found", not a pile of loosely
      // related papers.
      similarPapers = this.rankDiscoveryResults(query, main.candidates);
    }
    const similarPapersMs = Date.now() - similarStartedAt;

    // ---- PHASE 11: response ----------------------------------------------
    const sourcesChecked = mergeStatuses([...main.statuses, ...similarStatuses]);
    const notes = [...main.notes];
    if (!exactPaper) {
      if (similarPapers.length > 0) {
        notes.push(
          `No single paper could be identified from this query, so the ${similarPapers.length} most relevant results are returned instead.`,
        );
      } else {
        notes.push("No confident match was found in the configured academic sources.");
        if (main.candidates.length > 0) {
          notes.push(`${main.candidates.length} partial candidate(s) were seen but none met the match threshold.`);
        }
      }
    }

    const response: SearchResponse = {
      success: true,
      query: {
        title: query.title,
        authors: query.authors.length > 0 ? query.authors : undefined,
        keywords: query.keywords.length > 0 ? query.keywords : undefined,
        doi: query.doi,
        fromYear: query.fromYear,
        toYear: query.toYear,
        strategy: query.strategy,
      },
      exactPaper,
      fullText,
      similarPapers,
      sourcesChecked,
      searchCompleted: true,
      stoppedEarly: main.stoppedEarly,
      timings: {
        totalMs: Date.now() - startedAt,
        mainPaperMs,
        similarPapersMs,
      },
      notes: notes.length > 0 ? notes : undefined,
    };

    this.logger.info("search_completed", {
      found: Boolean(exactPaper),
      matchType: exactPaper?.matchType,
      confidence: exactPaper?.confidence,
      stoppedEarly: main.stoppedEarly,
      similarCount: similarPapers.length,
      totalMs: response.timings.totalMs,
    });

    return response;
  }

  /** Direct lookup for `GET /api/papers/:id`. */
  async lookupById(scheme: string, value: string, signal?: AbortSignal): Promise<PaperResult | null> {
    const results: PaperResult[] = [];
    const sources = [...this.registry.primarySources(), ...this.registry.fallbackSources()];

    for (const source of sources) {
      if (signal?.aborted) break;
      if (!source.isAvailable()) continue;
      try {
        const paper = await this.lookupFromSource(source, scheme, value, signal);
        if (paper) {
          results.push(paper);
          // One authoritative hit is enough; the rest would only add links.
          if (paper.doi || paper.pmcid || paper.arxivId) break;
        }
      } catch (error) {
        this.logger.debug("lookup_source_failed", {
          source: source.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (results.length === 0) return null;
    const { papers } = this.deduplicator.deduplicate(results);
    const paper = papers[0]!;
    const fullText = await this.resolveFullText(paper, signal);
    if (fullText?.url && !paper.pdfUrl && fullText.type === "pdf") paper.pdfUrl = fullText.url;
    return paper;
  }

  /**
   * Routes one scheme-prefixed id to the adapter method that understands it.
   * Sources that cannot answer for a given scheme are skipped without a
   * request being issued.
   */
  private async lookupFromSource(
    source: AcademicSource,
    scheme: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<PaperResult | null> {
    switch (scheme) {
      case "doi":
        return typeof source.getByDOI === "function" ? source.getByDOI(value, signal) : null;
      case "pmid":
      case "pmcid":
        // Only PubMed indexes these natively; others need the DOI instead.
        return source.key === "pubmed" && typeof source.getById === "function"
          ? source.getById(value, signal)
          : null;
      case "arxiv":
        if (source.key === "arxiv" && typeof source.getById === "function") {
          return source.getById(value, signal);
        }
        if (source.key === "semanticScholar" && typeof source.getById === "function") {
          return source.getById(`ARXIV:${value}`, signal);
        }
        return null;
      case "s2":
        return source.key === "semanticScholar" && typeof source.getById === "function"
          ? source.getById(value, signal)
          : null;
      case "openalex":
        return source.key === "openalex" && typeof source.getById === "function"
          ? source.getById(value, signal)
          : null;
      case "core":
        return source.key === "core" && typeof source.getById === "function"
          ? source.getById(value, signal)
          : null;
      case "doaj":
        return source.key === "doaj" && typeof source.getById === "function"
          ? source.getById(value, signal)
          : null;
      default:
        return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* PHASES 2-6                                                          */
  /* ------------------------------------------------------------------ */

  private async findMainPaper(query: NormalizedQuery, requestSignal?: AbortSignal): Promise<MainSearchOutcome> {
    const statuses: SourceStatus[] = [];
    const notes: string[] = [];
    const candidates: PaperResult[] = [];

    // PHASE 5's instrument: aborting this cancels every queued/in-flight
    // MAIN-PAPER request without touching the similar-paper stage.
    const mainController = new AbortController();
    const onRequestAbort = (): void => mainController.abort();
    requestSignal?.addEventListener("abort", onRequestAbort, { once: true });

    const deadline = Date.now() + this.config.budget.searchDeadlineMs;

    // The deadline is also enforced as a real timer, not just checked between
    // passes: a source stuck mid-await would otherwise hold the whole request
    // open indefinitely. Aborting the controller unblocks every source at once.
    let deadlineFired = false;
    const deadlineTimer = setTimeout(() => {
      deadlineFired = true;
      this.logger.warn("main_search_deadline_reached", {
        deadlineMs: this.config.budget.searchDeadlineMs,
      });
      mainController.abort();
    }, this.config.budget.searchDeadlineMs);

    try {
      const variants = buildQueryVariants(query, this.config.budget.maxResultsPerSource);
      if (variants.length === 0) {
        notes.push("The query did not contain enough information to search.");
        return { paper: null, verdict: null, statuses, stoppedEarly: false, notes, candidates };
      }

      const primary = this.registry.primarySources();
      const fallback = this.registry.fallbackSources();

      // ---- PHASE 2 + 3: primary sources ---------------------------------
      const primaryResult = await this.runPass(
        "primary",
        primary,
        variants,
        query,
        mainController,
        deadline,
        statuses,
        candidates,
      );

      if (primaryResult) {
        // ---- PHASE 5: immediate stop -------------------------------------
        mainController.abort();
        notes.push(
          `Exact match confirmed by ${primaryResult.paper.source}; remaining main-paper requests were cancelled.`,
        );
        this.logger.info("exact_match_found", {
          source: primaryResult.paper.source,
          phase: "primary",
          confidence: primaryResult.verdict.confidence,
          cancelledRemaining: true,
        });
        return {
          paper: primaryResult.paper,
          verdict: primaryResult.verdict,
          statuses,
          stoppedEarly: true,
          notes,
          candidates,
        };
      }

      // ---- PHASE 6: fallback sources, only because nothing matched -------
      if (fallback.length > 0 && Date.now() < deadline && !requestSignal?.aborted) {
        notes.push("No exact match in the primary sources; fallback sources were queried.");
        const fallbackResult = await this.runPass(
          "fallback",
          fallback,
          variants,
          query,
          mainController,
          deadline,
          statuses,
          candidates,
        );

        if (fallbackResult) {
          mainController.abort();
          notes.push(
            `Exact match confirmed by ${fallbackResult.paper.source}; remaining main-paper requests were cancelled.`,
          );
          this.logger.info("exact_match_found", {
            source: fallbackResult.paper.source,
            phase: "fallback",
            confidence: fallbackResult.verdict.confidence,
            cancelledRemaining: true,
          });
          return {
            paper: fallbackResult.paper,
            verdict: fallbackResult.verdict,
            statuses,
            stoppedEarly: true,
            notes,
            candidates,
          };
        }
      } else if (fallback.length > 0) {
        notes.push("Fallback sources were skipped because the search budget was exhausted.");
      }

      // ---- PHASE 6b: extended sources, only because NOTHING matched ------
      // Europe PMC / DataCite index preprints, theses and repository deposits
      // the earlier tiers often miss. They are the last resort, so they run
      // only when every source above returned nothing usable.
      const extended = this.registry.extendedSources();
      if (extended.length > 0 && Date.now() < deadline && !requestSignal?.aborted) {
        notes.push("Still nothing; extended academic sources were queried.");
        const extendedResult = await this.runPass(
          "extended",
          extended,
          variants,
          query,
          mainController,
          deadline,
          statuses,
          candidates,
        );

        if (extendedResult) {
          mainController.abort();
          notes.push(
            `Exact match confirmed by ${extendedResult.paper.source}; remaining main-paper requests were cancelled.`,
          );
          this.logger.info("exact_match_found", {
            source: extendedResult.paper.source,
            phase: "extended",
            confidence: extendedResult.verdict.confidence,
            cancelledRemaining: true,
          });
          return {
            paper: extendedResult.paper,
            verdict: extendedResult.verdict,
            statuses,
            stoppedEarly: true,
            notes,
            candidates,
          };
        }
      }

      // No exact match anywhere. Fall back to the strongest near-exact
      // candidate, clearly labelled as such rather than dressed up as exact.
      const best = this.bestNearExact(query, candidates);
      if (best) {
        notes.push(
          `No exact match; returning the closest candidate (${best.verdict.matchType}, confidence ${best.verdict.confidence.toFixed(2)}).`,
        );
        return {
          paper: best.paper,
          verdict: best.verdict,
          statuses,
          stoppedEarly: false,
          notes,
          candidates,
        };
      }

      return { paper: null, verdict: null, statuses, stoppedEarly: false, notes, candidates };
    } finally {
      clearTimeout(deadlineTimer);
      requestSignal?.removeEventListener("abort", onRequestAbort);
      // Release anything still queued behind this search.
      if (!mainController.signal.aborted) mainController.abort();
      if (deadlineFired) {
        notes.push(
          `The main-paper search hit its ${Math.round(this.config.budget.searchDeadlineMs / 1000)}s budget; slow sources were dropped.`,
        );
      }
    }
  }

  /**
   * Runs one pass (primary or fallback) over the sources, variant by variant.
   *
   * Sources within a variant run CONCURRENTLY but each is independently rate
   * limited, so "concurrent" never means "unthrottled". The first confirmed
   * exact match aborts the shared controller, which drops the rest.
   */
  private async runPass(
    phase: "primary" | "fallback" | "extended",
    sources: readonly AcademicSource[],
    variants: readonly QueryVariant[],
    query: NormalizedQuery,
    controller: AbortController,
    deadline: number,
    statuses: SourceStatus[],
    candidates: PaperResult[],
  ): Promise<{ paper: PaperResult; verdict: MatchVerdict } | undefined> {
    for (const variant of variants) {
      if (controller.signal.aborted || Date.now() >= deadline) break;

      let exact: { paper: PaperResult; verdict: MatchVerdict } | undefined;

      // Each source is verified the INSTANT it resolves, not after the whole
      // batch settles. The first exact match aborts the shared controller,
      // which cancels its still-in-flight siblings mid-request.
      //
      // arXiv and other id-less sources have nothing to answer a DOI-only
      // variant with; `search()` returns [] and no request is issued.
      const tasks = sources.map(async (source) => {
        const outcome = await this.searchOneSource(source, variant, phase, controller.signal);
        statuses.push(outcome.status);
        if (outcome.results.length === 0) return;

        candidates.push(...outcome.results);

        // ---- PHASE 4: exact-match verification ---------------------------
        const best = this.matchEngine.selectBest(query, outcome.results);
        if (best?.verdict.isExactMatch && !exact) {
          exact = { paper: this.matchEngine.annotate(best.paper, best.verdict), verdict: best.verdict };
          // ---- PHASE 5: immediate cancellation of the remaining siblings --
          controller.abort();
        }
      });

      // `searchOneSource` converts every failure into a status, so these
      // settle rather than reject; allSettled is belt-and-braces.
      const settled = await Promise.allSettled(tasks);
      for (let i = 0; i < settled.length; i += 1) {
        const outcome = settled[i]!;
        if (outcome.status === "rejected") {
          statuses.push(classifyFailure(sources[i]!.name, outcome.reason, 0));
        }
      }

      if (exact) return exact;
    }

    return undefined;
  }

  /** One source, one query variant, with full status accounting. */
  private async searchOneSource(
    source: AcademicSource,
    variant: QueryVariant,
    phase: string,
    signal: AbortSignal,
  ): Promise<{ results: PaperResult[]; status: SourceStatus }> {
    const startedAt = Date.now();

    if (!source.isAvailable()) {
      return {
        results: [],
        status: {
          name: source.name,
          status: "skipped",
          resultCount: 0,
          durationMs: 0,
          error: source.unavailableReason?.() ?? "source unavailable",
        },
      };
    }

    if (signal.aborted) {
      return {
        results: [],
        status: { name: source.name, status: "skipped", resultCount: 0, durationMs: 0, error: "cancelled" },
      };
    }

    try {
      // A DOI variant uses the dedicated identifier endpoint when the adapter
      // has one - far more precise than a free-text search.
      let results: PaperResult[];
      if (variant.label === "doi" && variant.query.doi && typeof source.getByDOI === "function") {
        const paper = await source.getByDOI(variant.query.doi, signal);
        results = paper ? [paper] : [];
      } else {
        results = await source.search(variant.query, signal);
      }

      const status: SourceStatus = {
        name: source.name,
        status: "success",
        resultCount: results.length,
        durationMs: Date.now() - startedAt,
      };
      this.logger.info("source_search_completed", {
        source: source.name,
        phase,
        variant: variant.label,
        durationMs: status.durationMs,
        resultCount: results.length,
      });
      return { results, status };
    } catch (error) {
      const status = classifyFailure(source.name, error, Date.now() - startedAt);
      // A cancelled request after an exact match is expected, not a failure.
      const isCancellation = error instanceof HttpError && error.kind === "aborted";
      this.logger[isCancellation ? "debug" : "warn"]("source_search_failed", {
        source: source.name,
        phase,
        variant: variant.label,
        status: status.status,
        error: status.error,
      });
      return { results: [], status };
    }
  }

  /** Best candidate that is close but did not clear the exact-match gate. */
  /**
   * Ranks raw candidates by relevance to the QUERY (not to a main paper).
   *
   * Used for keyword/author-only discovery searches, where no single paper can
   * be identified but the sources returned genuinely relevant work. Results are
   * deduplicated first, so the same paper found on five sources appears once.
   */
  private rankDiscoveryResults(query: NormalizedQuery, candidates: readonly PaperResult[]): PaperResult[] {
    const { papers } = this.deduplicator.deduplicate(candidates);

    const scored = papers
      .filter((paper) => withinYearRange(paper.year, query.fromYear, query.toYear))
      .map((paper) => ({ paper, verdict: this.matchEngine.evaluate(query, paper) }))
      .filter(({ verdict }) => verdict.score.finalScore > 0);

    const relevance = (e: { paper: PaperResult; verdict: MatchVerdict }): number =>
      e.verdict.score.finalScore + recencyBonus(e.paper.year, this.config.recencyBoost);

    scored.sort((a, b) => {
      if (relevance(b) !== relevance(a)) return relevance(b) - relevance(a);
      // Tie-breakers: more corroborating sources, then citations, then recency.
      const aSources = a.paper.sources?.length ?? 1;
      const bSources = b.paper.sources?.length ?? 1;
      if (aSources !== bSources) return bSources - aSources;
      const aCites = a.paper.citationCount ?? 0;
      const bCites = b.paper.citationCount ?? 0;
      if (aCites !== bCites) return bCites - aCites;
      return (b.paper.year ?? 0) - (a.paper.year ?? 0);
    });

    // Same distinct-title rule the similar-paper list uses, so a preprint and
    // its published version never both appear.
    const distinct = filterDistinctTitles(scored, (e) => e.paper.title, this.config.budget.maxSimilarPapers);

    return distinct.map(({ paper, verdict }) => ({
      ...paper,
      matchType: verdict.matchType,
      confidence: verdict.confidence,
      similarityScore: verdict.score.finalScore,
    }));
  }

  private bestNearExact(
    query: NormalizedQuery,
    candidates: readonly PaperResult[],
  ): { paper: PaperResult; verdict: MatchVerdict } | undefined {
    if (candidates.length === 0) return undefined;

    // A query with neither a title nor a DOI never names one paper, so there is
    // no "closest candidate" to promote - presenting one as `exactPaper` would
    // be a fabricated identification. Those queries go down the discovery path
    // (`rankDiscoveryResults`) instead.
    if (isDiscoveryQuery(query)) return undefined;

    const { papers } = this.deduplicator.deduplicate(candidates);
    const best = this.matchEngine.selectBest(query, papers);
    if (!best) return undefined;
    if (best.verdict.matchType === "keyword" && best.verdict.confidence < 0.4) return undefined;
    return { paper: this.matchEngine.annotate(best.paper, best.verdict), verdict: best.verdict };
  }

  /**
   * PHASE 7 - legal full-text resolution.
   *
   * Asks sources that expose a full-text endpoint, best access type first, and
   * falls back to the links already on the record. A paywalled paper resolves
   * to its official landing page; nothing here attempts to obtain a copy the
   * publisher has not made public.
   */
  private async resolveFullText(paper: PaperResult, signal?: AbortSignal): Promise<FullTextResult> {
    const best: FullTextResult[] = [deriveFullText(paper)];

    const preferred = ["openalex", "pubmed", "core", "semanticScholar"];
    for (const key of preferred) {
      if (signal?.aborted) break;
      const source = this.registry.get(key);
      if (!source || !source.isAvailable() || typeof source.getFullText !== "function") continue;
      // Only ask a source that plausibly knows this paper.
      if (!this.sourceKnowsPaper(key, paper)) continue;

      try {
        const result = await source.getFullText(paper, signal);
        if (result) best.push(result);
      } catch (error) {
        this.logger.debug("full_text_lookup_failed", {
          source: source.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // An open-access PDF is the best possible answer; stop as soon as we
      // have one rather than making further calls.
      if (best.some((r) => r.type === "pdf" && r.accessType === "open-access")) break;
    }

    return pickBestFullText(best);
  }

  private sourceKnowsPaper(key: string, paper: PaperResult): boolean {
    if (paper.sources?.some((s) => s.toLowerCase().includes(key.toLowerCase()))) return true;
    switch (key) {
      case "pubmed":
        return Boolean(paper.pmid || paper.pmcid || paper.doi);
      case "openalex":
        return Boolean(paper.doi || paper.pmid);
      case "core":
      case "semanticScholar":
        return Boolean(paper.doi || paper.arxivId);
      default:
        return Boolean(paper.doi);
    }
  }
}

/** Ranking of access types, best (most useful and fully legal) first. */
const ACCESS_RANK: Record<FullTextResult["accessType"], number> = {
  "open-access": 5,
  repository: 4,
  publisher: 3,
  "landing-page": 2,
  unavailable: 1,
};

export function pickBestFullText(results: readonly FullTextResult[]): FullTextResult {
  let best: FullTextResult = UNAVAILABLE_FULL_TEXT;
  let bestScore = -1;

  for (const result of results) {
    if (!result) continue;
    let score = ACCESS_RANK[result.accessType] * 10;
    if (result.type === "pdf") score += 3;
    if (result.available) score += 2;
    if (!result.url) score -= 20;
    if (score > bestScore) {
      bestScore = score;
      best = result;
    }
  }
  return best;
}

/** Collapses repeated per-source entries into one row per source. */
export function mergeStatuses(statuses: readonly SourceStatus[]): SourceStatus[] {
  const order: string[] = [];
  const byName = new Map<string, SourceStatus>();

  for (const status of statuses) {
    const existing = byName.get(status.name);
    if (!existing) {
      order.push(status.name);
      byName.set(status.name, { ...status });
      continue;
    }
    existing.resultCount += status.resultCount;
    existing.durationMs += status.durationMs;
    // A success anywhere outranks an earlier skip/failure for that source.
    if (existing.status !== "success" && status.status === "success") {
      existing.status = "success";
      delete existing.error;
    } else if (existing.status !== "success" && status.status !== "success") {
      existing.status = worseStatus(existing.status, status.status);
      existing.error ??= status.error;
    }
  }

  return order.map((name) => byName.get(name)!);
}

const STATUS_SEVERITY: Record<SourceStatus["status"], number> = {
  success: 0,
  skipped: 1,
  "rate-limited": 2,
  unavailable: 3,
  failed: 4,
};

function worseStatus(a: SourceStatus["status"], b: SourceStatus["status"]): SourceStatus["status"] {
  return STATUS_SEVERITY[a] >= STATUS_SEVERITY[b] ? a : b;
}

/**
 * A "discovery" query names no specific paper: keywords and/or authors only,
 * with no title and no DOI. It is answered with a ranked result list rather
 * than an identification.
 */
export function isDiscoveryQuery(query: NormalizedQuery): boolean {
  return !query.title && !query.doi;
}
