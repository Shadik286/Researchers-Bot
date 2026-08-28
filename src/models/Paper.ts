/**
 * Canonical paper representation used across every source adapter.
 *
 * Rule: adapters MUST NOT fabricate metadata. If a field is not present in the
 * upstream API response it stays `undefined` - never an empty string, never a
 * guessed value.
 */

export type MatchType = "exact" | "near-exact" | "similar" | "keyword";

export interface PaperResult {
  title: string;
  authors: string[];
  abstract?: string;
  doi?: string;
  year?: number;
  journal?: string;
  conference?: string;
  publisher?: string;
  keywords?: string[];

  /** Human readable name of the source adapter that produced this record. */
  source: string;
  /** Native identifier inside that source (e.g. the OpenAlex work id). */
  sourceId?: string;

  pmid?: string;
  pmcid?: string;
  arxivId?: string;

  landingPageUrl?: string;
  pdfUrl?: string;
  isOpenAccess?: boolean;

  matchType: MatchType;
  /** 0..1 - how confident we are that this record is the requested paper. */
  confidence: number;
  /** 0..1 - only set for similar-paper candidates. */
  similarityScore?: number;

  /** Populated by the deduplicator when the same paper came from >1 source. */
  sources?: string[];
  /** Landing/PDF links contributed by each source, kept after merging. */
  sourceLinks?: SourceLink[];

  /** Citation count where the source exposes one (used for tie-breaking). */
  citationCount?: number;
  /** Topics / concepts / subject headings exposed by the source. */
  topics?: string[];
  /** Reference DOIs, when cheaply available (OpenAlex, Semantic Scholar). */
  referenceIds?: string[];
}

export interface SourceLink {
  source: string;
  landingPageUrl?: string;
  pdfUrl?: string;
  sourceId?: string;
}

/**
 * Stable, opaque, URL-safe id for `GET /api/papers/:id`.
 * Format: `<scheme>:<value>` where scheme is one of
 * doi | pmid | pmcid | arxiv | s2 | openalex | core | doaj.
 */
export type PaperIdScheme =
  | "doi"
  | "pmid"
  | "pmcid"
  | "arxiv"
  | "s2"
  | "openalex"
  | "core"
  | "doaj";

export interface PaperId {
  scheme: PaperIdScheme;
  value: string;
}

/** Builds the canonical public id for a paper, preferring the strongest key. */
export function buildPaperId(paper: PaperResult): string | undefined {
  if (paper.doi) return `doi:${paper.doi}`;
  if (paper.pmcid) return `pmcid:${paper.pmcid}`;
  if (paper.pmid) return `pmid:${paper.pmid}`;
  if (paper.arxivId) return `arxiv:${paper.arxivId}`;
  if (paper.sourceId) {
    const scheme = SOURCE_ID_SCHEME[paper.source];
    if (scheme) return `${scheme}:${paper.sourceId}`;
  }
  return undefined;
}

const SOURCE_ID_SCHEME: Record<string, PaperIdScheme | undefined> = {
  "Semantic Scholar": "s2",
  OpenAlex: "openalex",
  CORE: "core",
  DOAJ: "doaj",
};
