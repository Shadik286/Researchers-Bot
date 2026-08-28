import type { AppConfig } from "../config/env.js";
import type { SourceRegistry } from "../config/sources.js";
import type { Logger } from "../logging/Logger.js";
import type { PaperResult } from "../models/Paper.js";
import type { AcademicSource, SourceStatus } from "../models/Source.js";
import { Deduplicator } from "./Deduplicator.js";
import { buildSimilarityQuery } from "./QueryBuilder.js";
import { RankingEngine, isSamePaper } from "./RankingEngine.js";
import { HttpError, isAbortError } from "../http/HttpError.js";

/**
 * PHASE 8 - similar-paper discovery.
 *
 * This runs AFTER the main paper is identified and is deliberately independent
 * of the main-paper AbortController: cancelling the main search must never
 * cancel this stage.
 *
 * Candidate routes, in order:
 *   1. Semantic Scholar `/recommendations` - the official related-paper API
 *   2. OpenAlex `related_works` + concept-filtered search
 *   3. Any other configured source exposing `getRelated`
 *   4. Keyword/topic search across the similar-source list, to top up
 *
 * The stage stops as soon as it has enough good candidates or the search budget
 * is exhausted; it never loops indefinitely and never fans out unbounded.
 */

export interface SimilarPaperOutcome {
  papers: PaperResult[];
  sourceStatuses: SourceStatus[];
  candidateCount: number;
}

export class SimilarPaperEngine {
  private readonly deduplicator = new Deduplicator();

  constructor(
    private readonly registry: SourceRegistry,
    private readonly ranking: RankingEngine,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async findSimilar(
    main: PaperResult,
    signal?: AbortSignal,
    yearRange?: { fromYear?: number; toYear?: number },
  ): Promise<SimilarPaperOutcome> {
    const budget = this.config.budget;
    const target = budget.maxSimilarPapers;
    const candidates: PaperResult[] = [];
    const statuses: SourceStatus[] = [];

    // The similar phase gets its own bounded budget and its own controller, so
    // a slow source cannot hold the response open. It is chained to the
    // caller's signal but is NOT the main-paper controller.
    const controller = new AbortController();
    const onOuterAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onOuterAbort, { once: true });
    const deadlineTimer = setTimeout(() => controller.abort(), budget.searchDeadlineMs);
    const phaseSignal = controller.signal;

    try {
      return await this.collect(main, phaseSignal, candidates, statuses, target, budget, yearRange);
    } finally {
      clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", onOuterAbort);
      if (!controller.signal.aborted) controller.abort();
    }
  }

  private async collect(
    main: PaperResult,
    signal: AbortSignal,
    candidates: PaperResult[],
    statuses: SourceStatus[],
    target: number,
    budget: AppConfig["budget"],
    yearRange?: { fromYear?: number; toYear?: number },
  ): Promise<SimilarPaperOutcome> {
    const sources = this.registry.similarSources();

    // ---- Route 1 + 2 + 3: official related/recommendation endpoints --------
    for (const source of sources) {
      if (signal?.aborted) break;
      if (candidates.length >= budget.maxSimilarCandidates) break;
      if (typeof source.getRelated !== "function") continue;

      const status = await this.runSource(source, "related", async () => {
        const related = await source.getRelated!(main, Math.min(target * 2, 40), signal);
        return related.filter((p) => !isSamePaper(main, p));
      }, candidates);
      statuses.push(status);
    }

    // ---- Route 4: topic/keyword search to top up ---------------------------
    const enoughFromRelated = this.countUsable(main, candidates) >= budget.minSimilarPapers;
    if (!enoughFromRelated && !signal?.aborted) {
      const query = buildSimilarityQuery(
        main.title,
        main.keywords ?? main.topics,
        Math.min(budget.maxResultsPerSource, target * 2),
      );

      for (const source of sources) {
        if (signal?.aborted) break;
        if (candidates.length >= budget.maxSimilarCandidates) break;
        if (this.countUsable(main, candidates) >= budget.maxSimilarPapers * 1.5) break;

        const status = await this.runSource(source, "similar-search", async () => {
          const results = await source.search(query, signal);
          return results.filter((p) => !isSamePaper(main, p));
        }, candidates);
        statuses.push(status);
      }
    }

    const { papers: deduplicated } = this.deduplicator.deduplicate(candidates);
    const ranked = this.ranking.rankSimilar(main, deduplicated, target, yearRange);

    this.logger.info("similar_search_completed", {
      candidateCount: candidates.length,
      uniqueCount: deduplicated.length,
      returned: ranked.length,
      target,
    });

    return { papers: ranked, sourceStatuses: statuses, candidateCount: candidates.length };
  }

  /* ------------------------------------------------------------------ */

  private async runSource(
    source: AcademicSource,
    operation: string,
    task: () => Promise<PaperResult[]>,
    sink: PaperResult[],
  ): Promise<SourceStatus> {
    const startedAt = Date.now();

    if (!source.isAvailable()) {
      return {
        name: source.name,
        status: "skipped",
        resultCount: 0,
        durationMs: 0,
        error: source.unavailableReason?.() ?? "source unavailable",
      };
    }

    try {
      const results = await task();
      sink.push(...results);
      const status: SourceStatus = {
        name: source.name,
        status: "success",
        resultCount: results.length,
        durationMs: Date.now() - startedAt,
      };
      this.logger.info("source_search_completed", {
        source: source.name,
        phase: "similar",
        operation,
        durationMs: status.durationMs,
        resultCount: results.length,
      });
      return status;
    } catch (error) {
      // A failing similarity source degrades the result set; it never fails
      // the request.
      const status = classifyFailure(source.name, error, Date.now() - startedAt);
      this.logger.warn("source_search_failed", {
        source: source.name,
        phase: "similar",
        operation,
        status: status.status,
        error: status.error,
      });
      return status;
    }
  }

  /** How many candidates are actually distinct from the main paper. */
  private countUsable(main: PaperResult, candidates: readonly PaperResult[]): number {
    const seen = new Set<string>();
    let count = 0;
    for (const candidate of candidates) {
      if (isSamePaper(main, candidate)) continue;
      const key = candidate.doi ?? candidate.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      count += 1;
    }
    return count;
  }
}

/** Maps a thrown error onto an honest, non-leaking source status. */
export function classifyFailure(sourceName: string, error: unknown, durationMs: number): SourceStatus {
  if (error instanceof HttpError) {
    if (error.isRateLimited) {
      return {
        name: sourceName,
        status: "rate-limited",
        resultCount: 0,
        durationMs,
        error: "provider rate limit reached; backed off",
      };
    }
    if (error.isAuthError) {
      return {
        name: sourceName,
        status: "skipped",
        resultCount: 0,
        durationMs,
        error: "source authentication/configuration issue",
      };
    }
    if (error.isForbidden) {
      // Access denied is respected as-is; no alternative route is attempted.
      return {
        name: sourceName,
        status: "unavailable",
        resultCount: 0,
        durationMs,
        error: "access denied by provider",
      };
    }
    if (error.kind === "aborted") {
      return { name: sourceName, status: "skipped", resultCount: 0, durationMs, error: "cancelled" };
    }
    if (error.kind === "timeout") {
      return { name: sourceName, status: "unavailable", resultCount: 0, durationMs, error: "request timed out" };
    }
    if (error.kind === "cooldown") {
      const seconds = error.retryAfterMs ? Math.ceil(error.retryAfterMs / 1000) : undefined;
      return {
        name: sourceName,
        status: "rate-limited",
        resultCount: 0,
        durationMs,
        error: seconds
          ? `provider quota exhausted; usable again in ~${formatDuration(seconds)}`
          : "provider quota exhausted",
      };
    }
    if (error.kind === "circuit-open") {
      // The breaker is protecting both us and the provider; no request was sent.
      const seconds = error.retryAfterMs ? Math.ceil(error.retryAfterMs / 1000) : undefined;
      return {
        name: sourceName,
        status: "unavailable",
        resultCount: 0,
        durationMs,
        error: seconds
          ? `circuit breaker open after repeated failures; retrying in ~${seconds}s`
          : "circuit breaker open after repeated failures",
      };
    }
    if (error.kind === "blocked") {
      return { name: sourceName, status: "failed", resultCount: 0, durationMs, error: "request blocked by URL policy" };
    }
    return {
      name: sourceName,
      status: error.isServerError ? "unavailable" : "failed",
      resultCount: 0,
      durationMs,
      error: error.status ? `provider responded ${error.status}` : "request failed",
    };
  }

  // A plain AbortError - thrown by fetch, or by any adapter that honours the
  // signal directly - is a cancellation, not a source failure.
  if (isAbortError(error)) {
    return { name: sourceName, status: "skipped", resultCount: 0, durationMs, error: "cancelled" };
  }

  return {
    name: sourceName,
    status: "failed",
    resultCount: 0,
    durationMs,
    error: error instanceof Error ? error.message.slice(0, 200) : "unknown error",
  };
}

/** "45075" -> "12h 31m", for human-readable source status. */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
