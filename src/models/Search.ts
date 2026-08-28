import type { FullTextResult } from "./FullText.js";
import type { PaperResult } from "./Paper.js";
import type { SourceStatus } from "./Source.js";

/** Raw, user-supplied search request (already validated, not yet normalized). */
export interface PaperSearchQuery {
  title?: string;
  authors?: string[];
  keywords?: string[];
  doi?: string;

  /** Only return papers published in or after this year. */
  fromYear?: number;
  /** Only return papers published in or before this year. */
  toYear?: number;

  /** Internal: how many results the adapter should ask the upstream API for. */
  limit?: number;
  /** Internal: adapters use this to pick between id lookup and free search. */
  intent?: "main" | "similar";
  /** Internal: free-form query string, prepared by the QueryBuilder. */
  freeText?: string;
}

/** Query after PHASE 1 normalization. */
export interface NormalizedQuery {
  raw: PaperSearchQuery;
  doi?: string;
  title?: string;
  normalizedTitle?: string;
  titleTokens: string[];
  authors: string[];
  normalizedAuthors: NormalizedAuthor[];
  keywords: string[];
  fromYear?: number;
  toYear?: number;
  strategy: "doi" | "title" | "keywords";
}

export interface NormalizedAuthor {
  /** Full normalized display form, e.g. "john doe". */
  full: string;
  /** Surname in lowercase, e.g. "doe". */
  last: string;
  /** First initial when derivable, e.g. "j". */
  firstInitial?: string;
}

export interface SearchResponse {
  success: true;
  query: {
    title?: string;
    authors?: string[];
    keywords?: string[];
    doi?: string;
    fromYear?: number;
    toYear?: number;
    strategy: NormalizedQuery["strategy"];
  };
  exactPaper: PaperResult | null;
  fullText: FullTextResult | null;
  similarPapers: PaperResult[];
  sourcesChecked: SourceStatus[];
  searchCompleted: boolean;
  stoppedEarly: boolean;
  timings: {
    totalMs: number;
    mainPaperMs: number;
    similarPapersMs: number;
  };
  notes?: string[];
}

export interface ApiErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
