import type { FullTextResult } from "./FullText.js";
import type { PaperResult } from "./Paper.js";
import type { PaperSearchQuery } from "./Search.js";

export type SourceStatusKind =
  | "success"
  | "failed"
  | "skipped"
  | "rate-limited"
  | "unavailable";

export interface SourceStatus {
  name: string;
  status: SourceStatusKind;
  resultCount: number;
  durationMs: number;
  error?: string;
}

/** How a source was reached during a particular search phase. */
export type SearchPhaseName =
  | "identifier"
  | "primary"
  | "fallback"
  | "similar"
  | "lookup";

/**
 * Contract every academic source adapter implements.
 *
 * Adapters receive their HttpClient / RateLimiter / Cache through the
 * constructor. They never reach into the HTTP server, the orchestrator or any
 * global singleton, which is what makes adding a new source a drop-in change.
 */
export interface AcademicSource {
  readonly name: string;

  /** Stable machine key used in configuration (e.g. `semanticScholar`). */
  readonly key: string;

  /**
   * `true` when the adapter has everything it needs to run (e.g. a required
   * API key is present). A source returning `false` is reported as "skipped".
   */
  isAvailable(): boolean;

  /** Reason shown to the client when `isAvailable()` is false. */
  unavailableReason?(): string | undefined;

  search(query: PaperSearchQuery, signal?: AbortSignal): Promise<PaperResult[]>;

  getByDOI?(doi: string, signal?: AbortSignal): Promise<PaperResult | null>;

  getById?(id: string, signal?: AbortSignal): Promise<PaperResult | null>;

  getFullText?(
    paper: PaperResult,
    signal?: AbortSignal,
  ): Promise<FullTextResult | null>;

  /**
   * Optional: papers related to a known paper. Implemented by adapters whose
   * upstream API exposes a recommendation / related-works endpoint.
   */
  getRelated?(
    paper: PaperResult,
    limit: number,
    signal?: AbortSignal,
  ): Promise<PaperResult[]>;
}
