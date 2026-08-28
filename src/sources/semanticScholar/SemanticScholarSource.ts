import type { PaperResult } from "../../models/Paper.js";
import type { PaperSearchQuery } from "../../models/Search.js";
import { normalizeDoi } from "../../utils/normalizeDoi.js";
import {
  BaseSource,
  buildPaper,
  cleanAuthors,
  cleanDoi,
  cleanKeywords,
  cleanText,
  cleanYear,
  type SourceDependencies,
} from "../BaseSource.js";

/**
 * Semantic Scholar (Academic Graph API)
 * =====================================
 *
 * API endpoints
 *   GET /graph/v1/paper/search              - relevance search
 *   GET /graph/v1/paper/search/match        - best single title match
 *   GET /graph/v1/paper/{id}                - by DOI:/ARXIV:/PMID:/CorpusId:/S2 id
 *   GET /recommendations/v1/papers/forpaper/{id} - official recommendations
 *
 * Authentication
 *   Optional. `x-api-key: <SEMANTIC_SCHOLAR_API_KEY>` when configured; without
 *   it the shared public pool is used, which is slower but fully functional.
 *
 * Rate limits
 *   The unauthenticated pool is shared and effectively ~1 request/second, so
 *   that is the configured ceiling. 429 responses are common on the public pool
 *   and are handled with Retry-After / exponential backoff by the HttpClient.
 *
 * Request format
 *   `fields` selects the response projection - always request explicitly, the
 *   default projection is nearly empty.
 *
 * Response mapping
 *   title, abstract, year, venue, authors[].name, externalIds{DOI,ArXiv,PubMed,
 *   PubMedCentral}, openAccessPdf{url}, fieldsOfStudy, citationCount, url.
 *
 * Similar papers
 *   The official recommendations endpoint is the primary source of the 8-10
 *   similar papers. This is an API-provided similarity signal - no scraping of
 *   the Semantic Scholar website is involved anywhere.
 *
 * Error handling
 *   404 -> unknown identifier (normal). 429 -> back off. The endpoint also
 *   returns 200 with `{"data": []}` for a search with no hits.
 */

const GRAPH_BASE = "https://api.semanticscholar.org/graph/v1";
const RECOMMENDATIONS_BASE = "https://api.semanticscholar.org/recommendations/v1";

const PAPER_FIELDS = [
  "paperId",
  "corpusId",
  "externalIds",
  "title",
  "abstract",
  "year",
  "venue",
  "publicationVenue",
  "publicationTypes",
  "authors",
  "fieldsOfStudy",
  "s2FieldsOfStudy",
  "openAccessPdf",
  "isOpenAccess",
  "citationCount",
  "url",
].join(",");

interface S2Author {
  authorId?: string | null;
  name?: string;
}

interface S2Paper {
  paperId?: string;
  corpusId?: number;
  externalIds?: {
    DOI?: string;
    ArXiv?: string;
    PubMed?: string;
    PubMedCentral?: string;
    CorpusId?: number;
  } | null;
  title?: string;
  abstract?: string | null;
  year?: number | null;
  venue?: string | null;
  publicationVenue?: { name?: string; type?: string; publisher?: string } | null;
  publicationTypes?: string[] | null;
  authors?: S2Author[];
  fieldsOfStudy?: string[] | null;
  s2FieldsOfStudy?: { category?: string; source?: string }[] | null;
  openAccessPdf?: { url?: string; status?: string; license?: string } | null;
  isOpenAccess?: boolean | null;
  citationCount?: number | null;
  url?: string;
}

interface S2SearchResponse {
  total?: number;
  offset?: number;
  next?: number;
  data?: S2Paper[];
}

interface S2RecommendationsResponse {
  recommendedPapers?: S2Paper[];
}

export class SemanticScholarSource extends BaseSource {
  readonly name = "Semantic Scholar";
  readonly key = "semanticScholar";

  private readonly apiKey: string | undefined;

  constructor(deps: SourceDependencies) {
    super(deps);
    this.apiKey = deps.config.apiKeys.semanticScholar;
  }

  /** Works with or without a key - the public pool needs no credential. */
  override isAvailable(): boolean {
    return true;
  }

  async search(query: PaperSearchQuery, signal?: AbortSignal): Promise<PaperResult[]> {
    const doi = normalizeDoi(query.doi);
    if (doi) {
      const paper = await this.getByDOI(doi, signal);
      return paper ? [paper] : [];
    }

    const text = this.buildQueryText(query);
    if (!text) return [];
    const limit = this.resultLimit(query);

    return this.withCache("search", [text, limit], async () =>
      this.notFoundAsEmpty(async () => {
        const { data } = await this.http.getJson<S2SearchResponse>(`${GRAPH_BASE}/paper/search`, {
          query: { query: text, limit: Math.min(limit, 100), fields: PAPER_FIELDS },
          signal,
          operation: "search",
        });
        return (data.data ?? [])
          .map((paper) => this.mapPaper(paper))
          .filter((p): p is PaperResult => p !== undefined)
          .slice(0, limit);
      }, []),
    );
  }

  /**
   * Title-first exact lookup. `/paper/search/match` returns the single best
   * title match, which is exactly what CASE B of the search strategy wants.
   */
  async matchTitle(title: string, signal?: AbortSignal): Promise<PaperResult | null> {
    const trimmed = title.trim();
    if (!trimmed) return null;

    return this.withCache("match", [trimmed], async () =>
      this.notFoundAsNull(async () => {
        const { data } = await this.http.getJson<S2SearchResponse>(`${GRAPH_BASE}/paper/search/match`, {
          query: { query: trimmed.slice(0, 500), fields: PAPER_FIELDS },
          signal,
          operation: "title-match",
        });
        const first = data.data?.[0];
        return first ? (this.mapPaper(first) ?? null) : null;
      }),
    );
  }

  async getByDOI(doi: string, signal?: AbortSignal): Promise<PaperResult | null> {
    const normalized = normalizeDoi(doi);
    if (!normalized) return null;
    return this.fetchPaper(`DOI:${normalized}`, "doi-lookup", signal);
  }

  /** Accepts an S2 paper id, or a prefixed id such as `ARXIV:2101.00001`. */
  async getById(id: string, signal?: AbortSignal): Promise<PaperResult | null> {
    const value = id.trim();
    if (!/^[A-Za-z]+:.+$/.test(value) && !/^[0-9a-f]{40}$/i.test(value)) return null;
    return this.fetchPaper(value, "id-lookup", signal);
  }

  /**
   * Official recommendation endpoint - the main engine behind the similar
   * papers phase.
   */
  async getRelated(paper: PaperResult, limit: number, signal?: AbortSignal): Promise<PaperResult[]> {
    const identifier = this.identifierFor(paper);
    if (!identifier) return [];

    return this.withCache("related", [identifier, limit], async () =>
      this.notFoundAsEmpty(async () => {
        const { data } = await this.http.getJson<S2RecommendationsResponse>(
          `${RECOMMENDATIONS_BASE}/papers/forpaper/${encodeURIComponent(identifier)}`,
          {
            query: { limit: Math.min(limit, 100), fields: PAPER_FIELDS },
            signal,
            operation: "recommendations",
          },
        );
        return (data.recommendedPapers ?? [])
          .map((item) => this.mapPaper(item, "similar"))
          .filter((p): p is PaperResult => p !== undefined);
      }, []),
    );
  }

  /* ------------------------------------------------------------------ */

  private async fetchPaper(identifier: string, operation: string, signal?: AbortSignal): Promise<PaperResult | null> {
    return this.withCache(operation, [identifier], async () =>
      this.notFoundAsNull(async () => {
        const { data } = await this.http.getJson<S2Paper>(
          `${GRAPH_BASE}/paper/${encodeURIComponent(identifier)}`,
          { query: { fields: PAPER_FIELDS }, signal, operation },
        );
        return this.mapPaper(data) ?? null;
      }),
    );
  }

  /** Strongest identifier Semantic Scholar will accept for this paper. */
  private identifierFor(paper: PaperResult): string | undefined {
    if (paper.source === this.name && paper.sourceId) return paper.sourceId;
    if (paper.doi) return `DOI:${paper.doi}`;
    if (paper.arxivId) return `ARXIV:${paper.arxivId}`;
    if (paper.pmid) return `PMID:${paper.pmid}`;
    if (paper.pmcid) return `PMCID:${paper.pmcid}`;
    return undefined;
  }

  private buildQueryText(query: PaperSearchQuery): string | undefined {
    // The graph search endpoint takes free text, not a field grammar.
    const parts: string[] = [];
    if (query.title) parts.push(query.title);
    for (const author of query.authors ?? []) if (author.trim()) parts.push(author.trim());
    if (parts.length === 0) {
      for (const keyword of query.keywords ?? []) if (keyword.trim()) parts.push(keyword.trim());
    }
    if (parts.length === 0 && query.freeText) parts.push(query.freeText);
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 500) : undefined;
  }

  private mapPaper(paper: S2Paper | undefined, matchType: "keyword" | "similar" = "keyword"): PaperResult | undefined {
    if (!paper) return undefined;

    const external = paper.externalIds ?? {};
    const doi = cleanDoi(external.DOI);
    const arxivId = cleanText(external.ArXiv);
    const pmid = cleanText(external.PubMed);
    const pmcidRaw = cleanText(external.PubMedCentral);
    const pmcid = pmcidRaw ? (pmcidRaw.toUpperCase().startsWith("PMC") ? pmcidRaw : `PMC${pmcidRaw}`) : undefined;

    const venue = cleanText(paper.publicationVenue?.name ?? paper.venue ?? undefined);
    const isConference =
      paper.publicationVenue?.type?.toLowerCase() === "conference" ||
      (paper.publicationTypes ?? []).some((t) => t?.toLowerCase() === "conference");

    const topics = [
      ...(paper.fieldsOfStudy ?? []),
      ...(paper.s2FieldsOfStudy ?? []).map((f) => f.category).filter((c): c is string => Boolean(c)),
    ]
      .map((t) => cleanText(t))
      .filter((t): t is string => Boolean(t));

    const uniqueTopics = [...new Set(topics)];

    return buildPaper({
      title: paper.title,
      authors: cleanAuthors((paper.authors ?? []).map((a) => a.name)),
      abstract: paper.abstract ?? undefined,
      doi,
      year: cleanYear(paper.year ?? undefined),
      journal: isConference ? undefined : venue,
      conference: isConference ? venue : undefined,
      publisher: cleanText(paper.publicationVenue?.publisher ?? undefined),
      keywords: cleanKeywords(uniqueTopics),
      source: this.name,
      sourceId: paper.paperId,
      pmid,
      pmcid,
      arxivId,
      landingPageUrl: paper.url ?? (doi ? `https://doi.org/${doi}` : undefined),
      // Only the openAccessPdf link is ever used - it is the publisher- or
      // repository-hosted copy Semantic Scholar itself verified as public.
      pdfUrl: paper.openAccessPdf?.url ?? undefined,
      isOpenAccess: paper.isOpenAccess ?? (paper.openAccessPdf?.url ? true : undefined),
      citationCount: typeof paper.citationCount === "number" ? paper.citationCount : undefined,
      topics: uniqueTopics.length > 0 ? uniqueTopics : undefined,
      matchType,
    });
  }

  /** API key travels in a request header only; the base client never logs it. */
  static headersFor(apiKey: string | undefined): Record<string, string> {
    return apiKey ? { "x-api-key": apiKey } : {};
  }
}
